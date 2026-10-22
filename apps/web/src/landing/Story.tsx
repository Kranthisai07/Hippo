const steps = [
  {
    h: "Drop a lease. Get a date.",
    p: 'Upload the PDF. Hippo finds "Give notice by Nov 1", quotes the clause and shows the page. Nothing is scheduled until you confirm the date.',
    src: "/landing/review.png",
    alt: "The Review screen: an extracted notice deadline beside the quoted lease clause, with a button to confirm the date.",
  },
  {
    h: "Ask while your hands are full.",
    p: '"My dishwasher is leaking, am I covered?" Yes, you are in warranty. Water damage from improper installation is excluded (page 3). File the claim within 30 days.',
    src: "/landing/ask.png",
    alt: "The Ask page answering a coverage question, with the warranty document and page cited under the answer.",
  },
  {
    h: "Hear it before you ask.",
    p: 'Your next question starts with one sentence: "Before that, your car insurance renews in 9 days." A daily email digest and a recall radar cover the days you never open the app.',
    src: "/landing/things.png",
    alt: "The Things screen listing the household's tracked items, such as appliances and policies.",
  },
];

export function Story() {
  return (
    <section id="story" className="lp-story" aria-labelledby="story-h">
      <div className="lp-wrap lp-story-head">
        <h2 id="story-h">Three moments, one quiet system</h2>
        <p className="lp-lead">An Alexa+ add-on, plus a web app where you upload and review your documents.</p>
      </div>
      <div className="lp-wrap lp-story-grid">
        <ol className="lp-steps">
          {steps.map((s) => (
            <li key={s.h} className="lp-step">
              <div className="lp-step-body">
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="lp-visual">
          {steps.map((s) => (
            <div className="lp-frame" key={s.src}>
              <img src={s.src} width={1280} height={720} alt={s.alt} loading="lazy" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
