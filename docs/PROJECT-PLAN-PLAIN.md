# The plan, in plain words

What we are building, what is finished, and what is left.

No technical wording. Written to be read by anyone.

_Last updated: 16 September 2026_

---

## 1. What this product does

A customer of ours — a compliance team, or a platform like Zquence — needs to know whether a
person has been reported in the news or in official records for something serious. Fraud, bribery,
money laundering, that kind of thing.

They send us a name. We search, read what we find, and hand back a summary a human reviewer can
check.

**We do not decide whether anyone is guilty.** We report what was published, how strong the
evidence is, and how far any case had got. A person is innocent unless a court said otherwise, and
our results say so.

---

## 2. What makes it different

Most screening tools return a list of hits and a risk score. Three deliberate differences:

**We always say what we did not search.** Every result carries an honest statement of its own
limits. "Found nothing" and "could not look" are different answers and we never blur them.

**There is no risk score.** A single number hides the reasoning. We return the evidence and the
reasoning instead, so a reviewer can disagree with us.

**We report the outcome, not just the accusation.** If someone was investigated and then cleared,
both come back. A tool that only shows the accusation is telling a reviewer someone is under
suspicion when a court has already said otherwise.

---

## 3. How a search works

1. **A name arrives.** The customer sends the person's details and the reason they are allowed to
   screen them.
2. **We plan what to look for.** Different phrasings, different languages.
3. **We search a ladder of sources** — official records first, then news, then the wider web.
4. **We read what we find** and pull out what is actually being alleged, and at what stage.
5. **We grade the evidence.** How well does this material support a connection to this person?
6. **We hand back the findings plus what we could not cover.**

---

## 4. The twelve stages of the build

We planned the work as twelve checkpoints. Nothing counts as done until it has been proved to
work.

| Stage                                  | What it means                                | State          |
| :------------------------------------- | :------------------------------------------- | :------------- |
| **0 — Decisions**                      | Agreeing what we are building and why        | ✅ Done        |
| **1 — Developer setup**                | Anyone can run the whole thing locally       | ✅ Done        |
| **2 — The rules engine**               | The reasoning, with no database involved     | ✅ Done        |
| **3 — Customers and security**         | Logins, permissions, keeping customers apart | ✅ Done        |
| **4 — Storage and queues**             | Saving work safely, surviving a crash        | ✅ Done        |
| **5 — Sources and categories**         | The register of where we look and for what   | ✅ Done        |
| **6 — Searching and fetching**         | Planning queries and retrieving documents    | 🟡 Mostly done |
| **7 — Reading and grading**            | Understanding documents and grading evidence | 🟡 Partly done |
| **8 — The screen people use**          | The web interface for reviewers              | ❌ Not started |
| **9 — Customer integration**           | Everything a platform needs to plug in       | 🟡 Partly done |
| **10 — Proving it works on real data** | Measuring what we actually find              | ❌ Not started |
| **11 — Production readiness**          | Deploying, monitoring, backups, sign-off     | ❌ Not started |

**Six of twelve complete. Three partly done. Three not started.**

---

## 5. What is finished

**The foundation is solid and proven.** A developer goes from an empty machine to a working search
in about fifteen minutes.

- **The reasoning engine works.** Evidence grading, categories, procedural stages, and ten safety
  rules that stop the system claiming more than it knows.
- **Security is real.** Customers cannot see each other's work. Permissions are enforced per
  action. Credentials are shown once and stored hashed.
- **Work survives failure.** If the system crashes mid-search, nothing is lost or half-written.
- **Sources are governed.** No source can be used until a named person has approved it, and taking
  one live needs two different people.
- **A search runs start to finish** and returns real results with real reasoning.
- **A real live search works.** We successfully searched a US regulator's published enforcement
  records and returned a genuine finding about a real person.
- **Customers manage their own access.** They issue and revoke their own keys without waiting for
  us.

---

## 6. What is left

### The three big pieces

**A) The screen people use** — _not started, the largest remaining piece_
There is no interface yet. Everything today is done through direct requests. A compliance officer
cannot use this product until this exists.

**B) Reading documents properly** — _partly done_
Today we match keywords. That finds obvious cases and misses subtle ones. Two specific gaps:

- We do not yet record **when** anything happened, so every finding is undated.
- Two news sites carrying the **same story** currently count as two separate confirmations, which
  makes evidence look stronger than it is.

**C) Proving it actually works** — _not started, and the most important_
We can demonstrate the system searching. We cannot yet tell a customer **what percentage of real
cases it finds**. Until we measure that, we cannot promise coverage, and every result correctly
says its coverage is unverified.

### The smaller pieces

- **More live sources.** One is connected. Two more are prepared and waiting on checks that are
  quick but must be done by a person.
- **Notifications.** Customers currently have to keep asking "is it finished yet?" rather than
  being told.
- **Usage limits.** Nothing stops a customer sending unlimited requests.
- **Running it for real.** No hosting, monitoring, backups or alerts yet. It runs on a laptop.

---

## 7. Decisions still needed from people, not engineers

These are not blocked on development. They are waiting on a decision.

| Decision                                                   | Who decides          |
| :--------------------------------------------------------- | :------------------- |
| How we approve access to each new source                   | Source admin         |
| Where "adverse media" ends and sanctions screening begins  | Product + compliance |
| How much a reviewer can realistically read, so we can tune | Product + compliance |
| Whether we ever show a confidence number (currently no)    | Product              |
| How far back each source reaches                           | Source admin         |

---

## 8. What we can honestly say today

**We can say:** the system works end to end, the reasoning is sound and tested, security and
customer separation are real, and it has successfully searched a live official source.

**We cannot yet say:** how much it finds, how well it reads subtle reporting, or that it is ready
to run in production.

**We would not say:** that a clean result means someone is clean. With one source connected and
coverage unmeasured, an empty result means we found nothing where we looked — and the system says
exactly that, every time.

---

## 9. What happens next

**Immediately:** make searching a source efficient — we currently re-fetch the same page dozens of
times per search, which burns through a publisher's fair-use limit in two or three searches.

**Then, in order of value:**

1. Read documents properly, including dates and spotting duplicate stories
2. Connect the two prepared sources so any name can be searched, not just names on one list
3. Measure what we actually find, against a set of known cases
4. Build the screen people use
5. Get it running somewhere real, with monitoring and backups

**The honest checkpoint is number 3.** Everything before it builds capability. Number 3 is where we
find out how good that capability actually is — and it is the first point at which we can make a
promise to a customer and mean it.
