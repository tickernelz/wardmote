import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./context/ThemeContext";
import {
  PublicIssueShareLegacyRedirect,
  PublicIssueSharePage,
  PublicShareUnavailable,
} from "./pages/PublicIssueSharePage";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Wardmote root element is missing");

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true } },
});

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/s/:token" element={<PublicIssueSharePage />} />
            <Route path="/s/:token/issues/:issueId" element={<PublicIssueShareLegacyRedirect />} />
            <Route path="*" element={<PublicShareUnavailable />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
