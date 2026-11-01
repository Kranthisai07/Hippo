import { CalendarClock, CreditCard, LogOut, Package, Settings, Upload } from "lucide-react";
import { Link, NavLink, Outlet } from "react-router";
import { useAuth } from "../lib/auth";
import { BrandMark } from "./BrandMark";

const LINKS = [
  { to: "/", label: "Coming up", icon: CalendarClock, end: true },
  { to: "/upload", label: "Upload", icon: Upload },
  { to: "/subscriptions", label: "Subscriptions", short: "Subs", icon: CreditCard },
  { to: "/things", label: "Things", icon: Package },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Brand() {
  return (
    <Link to="/" className="brand">
      <BrandMark />
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
      <header className="bar">
        <Brand />
        <nav className="nav" aria-label="Main">
          {LINKS.map(({ to, label, short, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} viewTransition aria-label={short ? label : undefined}>
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              {short ? (
                <>
                  <span className="nav-full" aria-hidden="true">
                    {label}
                  </span>
                  <span className="nav-short" aria-hidden="true">
                    {short}
                  </span>
                </>
              ) : (
                <span>{label}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="bar-end">
          {me && <p className="small muted bar-email">{me.email}</p>}
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
            <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>
      <div className="main">
        <main id="main" className="page" tabIndex={-1}>
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  );
}
