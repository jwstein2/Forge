/**
 * ops.pin_runway — keeps the only live marketing channel (QPK Pinterest RSS drip, CF-01) from silently running dry,
 * and turns platform receipts into channel verification.
 *
 *  1. Queue runway: reads the site's scheduled pin queue (pins.json) and alerts when fewer than `minRunwayDays`
 *     of future pins remain (warning) or none remain (critical). Unreadable queue → runway UNKNOWN (info alert), never "fine".
 *  2. Site feed: records items in our own /pins.xml as `site_feed` publications. That proves the feed served them,
 *     not that Pinterest published them.
 *  3. Platform receipts: when the channel has a Pinterest profile URL, reads the profile's public RSS and records
 *     `platform_feed` publications. Only these mark the channel `verified` (with the newest pin URL as receipt).
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { addEvidence, joinUrl, nowIso, newId, raiseAlert, recordCheck, resolveAlert, xmlTags, type Fetcher } from "../lib.ts";

interface QueueItem { slug?: string; title?: string; publish?: string }
const DAY = 86400000;

export function runway(queue: QueueItem[], now: Date): { future: number; lastPublish: string | null; days: number } {
  const times = queue.map((q) => Date.parse(q.publish ?? "")).filter((t) => Number.isFinite(t));
  const future = times.filter((t) => t > now.getTime());
  const last = times.length ? Math.max(...times) : null;
  return { future: future.length, lastPublish: last ? new Date(last).toISOString() : null, days: last && last > now.getTime() ? Math.floor((last - now.getTime()) / DAY) : 0 };
}

export function parseRssItems(xml: string): { link: string; title: string | null; pubDate: string | null }[] {
  return xmlTags(xml, "item").map((it) => ({
    link: xmlTags(it, "link")[0] ?? xmlTags(it, "guid")[0] ?? "",
    title: xmlTags(it, "title")[0] ?? null,
    pubDate: (() => { const d = Date.parse(xmlTags(it, "pubDate")[0] ?? ""); return Number.isFinite(d) ? new Date(d).toISOString() : null; })(),
  })).filter((x) => /^https?:\/\//.test(x.link));
}

/** Pinterest profile URL → public RSS URL (https://www.pinterest.com/<user>/feed.rss). */
export function profileFeed(accountUrl: string | null): string | null {
  if (!accountUrl) return null;
  const m = /^https:\/\/(?:[a-z]{2,3}\.|www\.)?pinterest\.[a-z.]+\/([A-Za-z0-9_]+)\/?$/.exec(accountUrl.trim());
  return m ? `https://www.pinterest.com/${m[1]}/feed.rss` : null;
}

export function pinRunway(fetcher: Fetcher): HandlerDef {
  return {
    kind: "ops.pin_runway",
    registryId: "OPS-PIN-RUNWAY",
    steps: [{
      name: "check",
      async run({ db, jobId, input, now }) {
        const channelId = (input.channelId as string) ?? "ch_qpk_pinterest";
        const minRunwayDays = Number(input.minRunwayDays ?? 5);
        const ch = await db.prepare(`SELECT c.id, c.niche_id, c.account_url, c.status, n.site_url, n.name FROM channels c JOIN niches n ON n.id = c.niche_id WHERE c.id = ?`).bind(channelId).first<{ id: string; niche_id: string; account_url: string | null; status: string; site_url: string; name: string }>();
        if (!ch) throw new Error(`channel ${channelId} not in registry`);
        const out: Record<string, unknown> = { channelId };

        // 1. queue runway
        const queueUrl = (input.queueUrl as string) ?? joinUrl(ch.site_url, "/pins.json");
        const q = await fetcher(queueUrl, { timeoutMs: 15000 });
        let queue: QueueItem[] | null = null;
        if (q.ok) { try { const j = JSON.parse(q.text); queue = Array.isArray(j) ? j : Array.isArray(j?.pins) ? j.pins : null; } catch { queue = null; } }
        const rkey = `ops:pins:runway:${channelId}`;
        if (!queue) {
          out.runway = { state: "unknown", queueUrl, status: q.status };
          await recordCheck(db, { kind: "pin_queue", nicheId: ch.niche_id, target: queueUrl, ok: false, status: q.status, latencyMs: q.latencyMs, findings: [{ code: "queue_unreadable", severity: "info", message: "Pin queue not readable; runway UNKNOWN." }], jobId });
          await raiseAlert(db, { key: rkey, severity: "info", nicheId: ch.niche_id, source: "ops.pin_runway", title: `${ch.name} Pinterest queue runway unknown`, detail: `Could not read ${queueUrl} (HTTP ${q.status ?? "none"}).`, nextAction: "Expose the queue (pins.json) or give FORGE the queue file path." });
        } else {
          const r = runway(queue, now);
          out.runway = { state: "known", ...r, queueSize: queue.length };
          const sev = r.future === 0 ? "critical" : r.days < minRunwayDays ? "warning" : null;
          await recordCheck(db, { kind: "pin_queue", nicheId: ch.niche_id, target: queueUrl, ok: !sev, status: q.status, latencyMs: q.latencyMs, findings: sev ? [{ code: "low_runway", severity: sev, message: `${r.future} future pins; last scheduled ${r.lastPublish ?? "never"}` }] : [], jobId });
          if (sev) await raiseAlert(db, { key: rkey, severity: sev, nicheId: ch.niche_id, source: "ops.pin_runway",
            title: r.future === 0 ? `${ch.name} Pinterest queue is empty` : `${ch.name} Pinterest queue runs out in ${r.days} day(s)`,
            detail: `${r.future} future pins; last scheduled publish ${r.lastPublish ?? "none"}. The only live marketing channel stops when the queue ends.`,
            nextAction: "Approve the next batch of pins (FORGE drafts them from the brief) and deploy the refreshed queue.", evidenceUrl: queueUrl });
          else await resolveAlert(db, rkey);
        }

        // 2. our own feed (not proof of platform publication)
        const feedUrl = joinUrl(ch.site_url, "/pins.xml");
        const feed = await fetcher(feedUrl, { timeoutMs: 15000 });
        const siteItems = feed.ok ? parseRssItems(feed.text) : [];
        for (const it of siteItems) await db.prepare(`INSERT INTO op_publications (id,channel_id,niche_id,external_url,title,published_at,observed_at,source) VALUES (?,?,?,?,?,?,?,'site_feed') ON CONFLICT(channel_id, external_url) DO NOTHING`)
          .bind(newId("pub"), channelId, ch.niche_id, it.link, it.title, it.pubDate, nowIso()).run();
        out.siteFeed = { ok: feed.ok, items: siteItems.length };

        // 3. platform receipts
        const pf = profileFeed(ch.account_url);
        if (!pf) out.platform = { state: "unconnected", reason: "No Pinterest profile URL on the channel record; publication on Pinterest cannot be verified by FORGE." };
        else {
          const p = await fetcher(pf, { timeoutMs: 15000 });
          const items = p.ok ? parseRssItems(p.text) : [];
          for (const it of items) await db.prepare(`INSERT INTO op_publications (id,channel_id,niche_id,external_url,title,published_at,observed_at,source) VALUES (?,?,?,?,?,?,?,'platform_feed') ON CONFLICT(channel_id, external_url) DO NOTHING`)
            .bind(newId("pub"), channelId, ch.niche_id, it.link, it.title, it.pubDate, nowIso()).run();
          const newest = items.filter((i) => i.pubDate).sort((a, b) => (b.pubDate! > a.pubDate! ? 1 : -1))[0];
          const skey = `ops:pins:stale:${channelId}`;
          if (newest) {
            await db.prepare(`UPDATE channels SET status='verified', last_verified_at=?, last_verified_url=?, updated_at=? WHERE id=?`).bind(newest.pubDate, newest.link, nowIso(), channelId).run();
            await addEvidence(db, { subjectType: "channel", subjectId: channelId, claim: `Newest Pinterest pin observed in the public profile feed: ${newest.title ?? newest.link}`, label: "VERIFIED", source: "pinterest.profile_rss", url: newest.link, collectedBy: "ops.pin_runway" });
            const ageDays = (now.getTime() - Date.parse(newest.pubDate!)) / DAY;
            if (ageDays > 3) await raiseAlert(db, { key: skey, severity: "warning", nicheId: ch.niche_id, source: "ops.pin_runway", title: `No new ${ch.name} pin on Pinterest for ${Math.floor(ageDays)} days`, detail: `Newest pin ${newest.pubDate}. The drip publishes daily when the queue has items.`, evidenceUrl: newest.link });
            else await resolveAlert(db, skey);
          } else if (p.status !== null) {
            await raiseAlert(db, { key: skey, severity: "warning", nicheId: ch.niche_id, source: "ops.pin_runway", title: `${ch.name} Pinterest profile feed shows no pins`, detail: `Fetched ${pf}: HTTP ${p.status}, 0 items.` });
          }
          out.platform = { state: p.ok ? "read" : "error", status: p.status, items: items.length, newest: newest?.link ?? null };
        }
        return { output: out };
      },
    }],
  };
}
