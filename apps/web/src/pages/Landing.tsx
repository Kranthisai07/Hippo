import "../landing.css";
import { Bento } from "../landing/Bento";
import { Header } from "../landing/Header";
import { Hero } from "../landing/Hero";
import { Closing, Footer, Planned, Trust } from "../landing/Rest";
import { Story } from "../landing/Story";

export default function Landing() {
  return (
    <div className="lp">
      <Header />
      <main id="main">
        <Hero />
        <Story />
        <Bento />
        <Trust />
        <Planned />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
