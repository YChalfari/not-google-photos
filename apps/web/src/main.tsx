import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '@/App';
import { NativeRuntime } from '@/components/native-runtime';
import { StatusProvider } from '@/components/status';
import { SessionProvider } from '@/session';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <StatusProvider>
          <NativeRuntime />
          <SessionProvider>
            <App />
          </SessionProvider>
        </StatusProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
