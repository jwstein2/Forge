import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createApiSource } from './apiSource';
import { createFixtureSource } from './fixtureSource';
import type { CommandDataSource } from './types';

const DataContext = createContext<CommandDataSource | null>(null);

export function defaultSource(): CommandDataSource {
  const base = import.meta.env.VITE_FORGE_API as string | undefined;
  const devToken = import.meta.env.VITE_FORGE_DEV_TOKEN as string | undefined;
  return base ? createApiSource(base, { devToken }) : createFixtureSource();
}

export function DataProvider({ source, children }: { source?: CommandDataSource; children: ReactNode }) {
  const [value] = useState(() => source ?? defaultSource());
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useSource(): CommandDataSource {
  const s = useContext(DataContext);
  if (!s) throw new Error('useSource must be used inside DataProvider');
  return s;
}

export type Resource<T> = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'ready'; data: T };

/** Load a value from the data source; reloads when deps change. */
export function useResource<T>(load: (s: CommandDataSource) => Promise<T>, deps: unknown[]): [Resource<T>, (d: T) => void] {
  const source = useSource();
  const [res, setRes] = useState<Resource<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setRes({ status: 'loading' });
    load(source).then(
      (data) => live && setRes({ status: 'ready', data }),
      (error: Error) => live && setRes({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, ...deps]);
  return [res, (data: T) => setRes({ status: 'ready', data })];
}
