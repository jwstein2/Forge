import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { DataProvider, useSource } from './data/DataContext';
import type { CommandDataSource } from './data/types';
import { AccountsScreen } from './screens/Accounts';
import { BuilderScreen } from './screens/Builder';
import { NicheDetailScreen, NichesIndex } from './screens/Niches';
import { OperationsScreen } from './screens/Operations';
import { OpportunitiesScreen } from './screens/Opportunities';
import { PortfolioScreen } from './screens/Portfolio';
import { EmptyState, PageHeader } from './components/primitives';

function Shell({ children }: { children: ReactNode }) {
  const source = useSource();
  const [open, setOpen] = useState<number | undefined>();
  useEffect(() => {
    source.getPortfolio().then(
      (p) => setOpen(p.alerts.filter((a) => a.state !== 'resolved').length),
      () => setOpen(undefined),
    );
  }, [source]);
  return <AppShell openAlerts={open}>{children}</AppShell>;
}

export function AppRoutes() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<PortfolioScreen />} />
        <Route path="/niches" element={<NichesIndex />} />
        <Route path="/niches/:id" element={<NicheDetailScreen />} />
        <Route path="/opportunities" element={<OpportunitiesScreen />} />
        <Route path="/builder" element={<BuilderScreen />} />
        <Route path="/operations" element={<OperationsScreen />} />
        <Route path="/accounts" element={<AccountsScreen />} />
        <Route
          path="*"
          element={
            <div className="page">
              <PageHeader kicker="FORGE Command" title="Page not found" />
              <EmptyState icon="question" title="Where to go" level={2}>
                <p>Use the navigation to return to the portfolio.</p>
              </EmptyState>
            </div>
          }
        />
      </Routes>
    </Shell>
  );
}

export function App({ source }: { source?: CommandDataSource }) {
  return (
    <DataProvider source={source}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </DataProvider>
  );
}

/** Test harness: same app on an in-memory router. */
export function TestApp({ source, path = '/' }: { source?: CommandDataSource; path?: string }) {
  return (
    <DataProvider source={source}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </DataProvider>
  );
}
