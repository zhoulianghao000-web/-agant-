import type { ReactNode } from 'react';
import { AppProviders } from './providers';
import { AppRouter } from './router';

export function App(): ReactNode {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
