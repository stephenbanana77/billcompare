import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from 'react-error-boundary';

import { AppContainer } from '@lark-apaas/client-toolkit/components/AppContainer';
import { ErrorRender } from '@lark-apaas/client-toolkit/components/ErrorRender';

import RoutesComponent from './app.tsx';
import './index.css';
import { createPortal } from 'react-dom';
import { Toaster } from '@client/src/components/ui/sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const LEGACY_APP_BASE_PATH = '/app/app_17a7d7fdmvg';
const CLIENT_BASE_PATH = window.location.pathname.startsWith(
  LEGACY_APP_BASE_PATH,
)
  ? LEGACY_APP_BASE_PATH
  : '/';
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1 } },
});

const MainApp = () => {
  return (
    <BrowserRouter basename={CLIENT_BASE_PATH}>
      <QueryClientProvider client={queryClient}>
        <AppContainer defaultTheme="light">
          <ErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
              <ErrorRender
                error={error as Error}
                resetErrorBoundary={resetErrorBoundary}
              />
            )}
          >
            <RoutesComponent />
            {createPortal(<Toaster />, document.body)}
          </ErrorBoundary>
        </AppContainer>
      </QueryClientProvider>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('root')!).render(<MainApp />);
