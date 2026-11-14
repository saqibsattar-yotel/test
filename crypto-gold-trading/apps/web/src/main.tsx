import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { isWarmingError } from "./lib/api";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // "Still downloading" (first start on a new machine) is not an error: keep the loading state and
      // ask again every few seconds until the data is there. Real failures are retried once, as before.
      retry: (failureCount, error) => isWarmingError(error) || failureCount < 1,
      retryDelay: (attempt, error) => (isWarmingError(error) ? 4000 : Math.min(1000 * 2 ** attempt, 30_000)),
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
