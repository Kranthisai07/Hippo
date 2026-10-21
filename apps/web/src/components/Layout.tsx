import { CalendarClock, LogOut, MessageSquare, Package, Settings, Upload } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth } from "../lib/auth";

const LINKS = [
  { to: "/", label: "Coming up", icon: CalendarClock, end: true },
  { to: "/upload", label: "Upload", icon: Upload },
  { to: "/things", label: "Things", icon: Package },
  { to: "/ask", label: "Ask", icon: MessageSquare },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
          <path d="M7 22c0-6 4-10 9-10s9 4 9 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="12" cy="18" r="1.8" fill="currentColor" />
          <circle cx="20" cy="18" r="1.8" fill="currentColor" />
        </svg>
      </span>
      Hippo
    </Link>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <Link to="/privacy">Privacy</Link>
      <Link to="/terms">Terms</Link>
    </footer>
  );
}

export function Layout() {
  const { signOut, me } = useAuth();
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Brand />
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </button>
      </header>
      <aside className="side">
        <Brand />
        <nav className="nav" aria-label="Main">
          {LINKS.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}>
              <Icon size={20} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          {me && <p className="small muted">{me.email}</p>}
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <main id="main" className="page" tabIndex={-1}>
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
