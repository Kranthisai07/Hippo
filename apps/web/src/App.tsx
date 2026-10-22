import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { Skeleton, ToastProvider } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { HOSTED } from "./lib/hosted";
import { ComingUp } from "./pages/ComingUp";
import { Legal } from "./pages/Legal";
import { Review } from "./pages/Review";
import { SettingsPage } from "./pages/Settings";
import { SignIn } from "./pages/SignIn";
import { ThingDetail, Things } from "./pages/Things";
import { UploadPage } from "./pages/Upload";

const AskPage = lazy(() => import("./ask/AskPage"));
const Landing = lazy(() => import("./pages/Landing"));

function Protected() {
  const { status } = useAuth();
  const here = useLocation();
  if (status === "loading") {
    return (
      <div className="page">
        <Skeleton lines={4} label="Checking your session" />
      </div>
    );
  }
  if (status === "out") return <Navigate to="/signin" replace state={{ from: here.pathname }} />;
  return <Layout />;
}

// The static site has no API, so the only routes are the landing page and the legal pages. Everything else, including
// links inside those pages that point at "/", goes to the landing page (a server redirect cannot catch client navigation).
function HostedApp() {
  return (
    <Routes>
      <Route
        path="/welcome"
        element={
          <Suspense fallback={<Skeleton lines={3} label="Loading" />}>
            <Landing />
          </Suspense>
        }
      />
      <Route path="/privacy" element={<Legal which="privacy" />} />
      <Route path="/terms" element={<Legal which="terms" />} />
      <Route path="*" element={<Navigate to="/welcome" replace />} />
    </Routes>
  );
}

export function App() {
  if (HOSTED) return <HostedApp />;
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/privacy" element={<Legal which="privacy" />} />
          <Route path="/terms" element={<Legal which="terms" />} />
          {/* The demo page signs in on its own with OAuth, like Alexa+ would, so it sits outside the web app session. */}
          {["/ask", "/callback"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<Skeleton lines={3} label="Loading" />}>
                  <AskPage />
                </Suspense>
              }
            />
          ))}
          <Route
            path="/welcome"
            element={
              <Suspense fallback={<Skeleton lines={3} label="Loading" />}>
                <Landing />
              </Suspense>
            }
          />
          <Route element={<Protected />}>
            <Route index element={<ComingUp />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/review/:docId" element={<Review />} />
            <Route path="/things" element={<Things />} />
            <Route path="/things/:assetId" element={<ThingDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
