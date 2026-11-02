import { GEIST_WOFF2 } from "./geistFont";

// The look of the server rendered pages. Tokens are copied from apps/web/src/tokens.css so the sign in window and the
// web app read as one product. Inline only: the page CSP allows no external style, script or image (font-src data: only).
// Light first, dark through prefers-color-scheme. No script, so every state is plain HTML and CSS.

export const THEME = `
@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(${GEIST_WOFF2}) format("woff2")}
:root{color-scheme:light dark;
--font:"Geist Variable",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--bg:#f3f6f5;--surface:#fff;--surface-2:#e9efed;--line:#d3dcd9;--ink:#0d1a18;--ink-2:#405450;
--accent:#0b6b61;--accent-hover:#07554d;--on-accent:#fff;--accent-soft:#d9eeea;--accent-wash:#eaf6f4;--focus:#0b57d0;
--urgent:#a1261c;--urgent-soft:#fbe9e6;--ok:#1d6b3a;--ok-soft:#e1f3e6;
--shadow2:0 10px 30px rgb(13 42 38/.1),0 2px 8px rgb(13 42 38/.06);--shadow3:0 28px 70px rgb(13 42 38/.18),0 6px 18px rgb(13 42 38/.08)}
@media (prefers-color-scheme:dark){:root{
--bg:#0a1311;--surface:#111d1a;--surface-2:#182622;--line:#2b3f3a;--ink:#e8f1ef;--ink-2:#a8bdb8;
--accent:#5fd0c0;--accent-hover:#86e0d2;--on-accent:#04201c;--accent-soft:#123430;--accent-wash:#0f2623;--focus:#8ab4ff;
--urgent:#ff9d92;--urgent-soft:#3d1c19;--ok:#86d9a0;--ok-soft:#173223;
--shadow2:0 12px 34px rgb(0 0 0/.5);--shadow3:0 30px 80px rgb(0 0 0/.6)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px 16px;
font:16px/1.5 var(--font);color:var(--ink);background:radial-gradient(1200px 520px at 50% -10%,var(--accent-wash),transparent 70%),var(--bg);
-webkit-font-smoothing:antialiased}
h1,h2,p,ul{margin:0}
.shell{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r3,20px);box-shadow:var(--shadow3);overflow:hidden;animation:rise .18s ease-out both}
.panel{display:none}
.main{padding:32px 28px 28px;display:flex;flex-direction:column;gap:20px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:650;font-size:20px;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.mark{width:32px;height:32px;border-radius:10px;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;flex:none}
h1{font-size:26px;line-height:1.2;font-weight:650;letter-spacing:-.02em}
.sub{color:var(--ink-2);font-size:15px;margin-top:4px}
.sub strong{color:var(--ink);font-weight:600}
.stack{display:flex;flex-direction:column;gap:16px}
form{display:flex;flex-direction:column;gap:16px}
.field{display:flex;flex-direction:column;gap:6px}
label{font-size:14px;font-weight:600}
input[type=email],input[type=text]{width:100%;min-height:48px;padding:10px 14px;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:var(--r1,10px);transition:border-color .18s,box-shadow .18s}
input::placeholder{color:var(--ink-2);opacity:.8}
input:hover{border-color:var(--ink-2)}
input[aria-invalid=true]{border-color:var(--urgent)}
.code{font-size:26px;font-weight:600;letter-spacing:.4em;text-align:center;font-variant-numeric:tabular-nums;padding-left:calc(14px + .4em)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
input:focus-visible{outline-offset:0;border-color:var(--focus)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;padding:10px 18px;font:inherit;font-weight:600;font-size:16px;line-height:1.2;border-radius:999px;border:1px solid transparent;cursor:pointer;text-decoration:none;transition:background-color .18s,border-color .18s,transform .12s}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--accent);color:var(--on-accent)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-secondary{background:var(--surface);color:var(--ink);border-color:var(--line)}
.btn-secondary:hover{background:var(--surface-2)}
.btn-quiet{background:transparent;color:var(--ink-2);min-height:44px;font-weight:500;font-size:15px}
.btn-quiet:hover{color:var(--ink);background:var(--surface-2)}
.btn-google{background:var(--surface);color:var(--ink);border-color:var(--line)}
.btn-google:hover{background:var(--surface-2)}
.btn-google svg{flex:none}
.or{display:flex;align-items:center;gap:12px;color:var(--ink-2);font-size:14px}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}
.banner{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r1,10px);font-size:15px;line-height:1.4;border:1px solid transparent}
.banner svg{flex:none;margin-top:1px}
.banner-error{background:var(--urgent-soft);color:var(--urgent);border-color:currentColor}
.banner-ok{background:var(--ok-soft);color:var(--ok);border-color:currentColor}
.who{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--accent-wash);border:1px solid var(--line);border-radius:var(--r2,14px)}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font-weight:650;flex:none;text-transform:uppercase}
.who-text{min-width:0;font-size:15px}
.who-text b{display:block;overflow-wrap:anywhere;font-weight:600}
.who-text span{color:var(--ink-2);font-size:14px}
.row{display:flex;gap:8px}
.row .btn{flex:1}
.demo{display:flex;align-items:center;gap:10px;padding-top:4px;border-top:1px dashed var(--line);margin-top:4px}
.demo .btn{flex:1}
.tag{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:var(--surface-2);color:var(--ink-2);border:1px solid var(--line)}
.small{font-size:13px;color:var(--ink-2)}
.foot{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 16px;font-size:13px;color:var(--ink-2)}
.foot a{color:var(--ink-2);text-underline-offset:3px;min-height:24px}
.foot a:hover{color:var(--ink)}
.icon{display:grid;place-items:center;width:48px;height:48px;border-radius:50%;background:var(--accent-soft);color:var(--accent)}
.points{list-style:none;padding:0;display:flex;flex-direction:column;gap:12px}
.points li{display:flex;gap:10px;align-items:flex-start;font-size:15px;color:var(--ink-2)}
.points svg{flex:none;margin-top:3px;color:var(--accent)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (min-width:760px){
body{padding:40px}
.shell{max-width:880px;display:grid;grid-template-columns:minmax(0,360px) minmax(0,1fr)}
.panel{display:flex;flex-direction:column;gap:28px;justify-content:space-between;padding:40px 36px;background:var(--accent-wash);border-right:1px solid var(--line)}
.lede{font-size:26px;line-height:1.25;font-weight:650;letter-spacing:-.02em}
.main{padding:48px 44px;justify-content:center}
.main .brand{display:none}
.shell.single{display:block;max-width:440px}
.shell.single .main .brand{display:inline-flex}
.shell.single .main{padding:32px 28px 28px}
}
@media (max-width:480px){.row{flex-direction:column;gap:0}}
@media (max-width:380px){.main{padding:24px 20px 20px}h1{font-size:24px}.code{letter-spacing:.3em}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media (forced-colors:active){.btn,input,.banner,.shell{border:1px solid CanvasText}.btn-primary{forced-color-adjust:none;background:ButtonText;color:ButtonFace}}
`;
