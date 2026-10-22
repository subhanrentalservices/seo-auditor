// First run, and "Add a website": type the address, check what was found, start.
import {api, html, render, $, toast} from "../core.js";

export function mount(root, opts) {
  let found = null, typed = "";
  function step1(err = "") {
    render(root, html`<div class="welcome"><div class="box">
      <h1>${opts.adding ? "Add a website" : "Which website do you want links for?"}</h1>
      <p class="lead">${opts.adding ? "Each website gets its own links, opportunities and settings."
        : "Type your address. The tool reads your home page and fills in what it can: your business name, your services, your best pages."}</p>
      <form id="f" class="big-input" novalidate><input class="input" id="domain" placeholder="yoursite.com.au" autocomplete="url" aria-label="Website address" value="${typed}" autofocus>
        <button class="btn primary" id="go" type="submit">Continue</button></form>
      <p class="err" role="alert">${err}</p>
      ${opts.adding ? html`<p><button class="btn quiet" id="cancel">Cancel</button></p>` : ""}
    </div></div>`);
    $("#f", root).onsubmit = async e => {
      e.preventDefault();
      const domain = typed = $("#domain", root).value.trim();
      if (!domain) return step1("Type your website address, like ssautomotive.com.au");
      const b = $("#go", root); b.disabled = true; b.textContent = "Reading your site…";
      try { found = await api("/detect", {domain}); step2(); }
      catch (err) { step1(err.message); }
    };
    $("#cancel", root)?.addEventListener("click", () => opts.cancel());
    $("#domain", root).focus();
  }
  function step2() {
    const f = found;
    const brand = f.brand_names[0] || "";
    render(root, html`<div class="welcome"><div class="box">
      <h1>${f.reachable ? `Found ${brand || f.domain}` : `Couldn't open ${f.domain}`}</h1>
      <p class="lead">${f.reachable ? "Check these, change anything that's wrong, and start. You can edit all of it later in Settings."
        : "You can still add it and fill these in yourself, or go back and check the address."}</p>
      ${f.problems.map(p => html`<div class="notice bad"><b>Worth fixing:</b> ${p}</div>`)}
      ${f.social.length ? html`<p class="muted" style="font-size:14px">Your site links to: ${f.social.map(s => s.name).join(", ")}. Make sure each of those profiles links back to your site.</p>` : ""}
      <form id="f2" class="found" novalidate>
        <div class="field"><label for="w-brand">Business names</label><div class="help">How people write your name, one per line. Used to find mentions of you.</div>
          <textarea class="input" id="w-brand" rows="2">${f.brand_names.join("\n")}</textarea></div>
        <div class="field"><label for="w-topics">What you do</label><div class="help">Your services, one per line. Used to match journalist requests and resource lists.</div>
          <textarea class="input" id="w-topics" rows="4">${f.topics.join("\n")}</textarea></div>
        <div class="field"><label for="w-comp">Competitors</label><div class="help">2 to 6 competitor websites, one per line. The best opportunities are sites that link to them but not to you.</div>
          <textarea class="input" id="w-comp" rows="3" placeholder="competitor-one.com.au"></textarea></div>
        <div class="grid2">
          <div class="field"><label for="w-company">Business name</label><input class="input" id="w-company" value="${brand}" placeholder="Used to sign emails"></div>
          <div class="field"><label for="w-name">Your name</label><input class="input" id="w-name" placeholder="Signs your emails"></div></div>
        <div class="field"><label for="w-email">Your email</label><input class="input" id="w-email" value="${f.emails[0] || ""}"></div>
        <input type="hidden" id="w-pages" value="${f.pages.join("\n")}">
        <p class="err" id="err2" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit" id="start">Start</button><button class="btn quiet" type="button" id="back">Back</button></div>
      </form></div></div>`);
    $("#back", root).onclick = () => step1();
    $("#f2", root).onsubmit = async e => {
      e.preventDefault();
      const b = $("#start", root); b.disabled = true; b.textContent = "Setting up…";
      const settings = {brand_names: $("#w-brand", root).value, topics: $("#w-topics", root).value, competitors: $("#w-comp", root).value,
        profile_name: $("#w-name", root).value, profile_email: $("#w-email", root).value, profile_company: $("#w-company", root).value,
        my_pages: $("#w-pages", root).value};
      try {
        const r = await api("/sites", {domain: f.domain, settings});
        toast(`${f.domain} is ready`);
        opts.done(r.site.id);
      } catch (err) {
        b.disabled = false; b.textContent = "Start";
        const existing = (opts.sites || []).find(x => x.domain.replace(/^www\./, "") === f.domain);
        if (/already set up/.test(err.message) && existing) { toast(err.message + " Opening it."); return opts.done(existing.id); }
        $("#err2", root).textContent = err.message;
      }
    };
  }
  step1();
}
