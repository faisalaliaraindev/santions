# Where this project is — in plain words

Last updated: 2026-09-15

This file explains the project in simple English. The other docs are detailed and technical.
This one is not. If you only read one file, read this one.

---

## 1. What the service does

You give it a person's name. It searches free, public sources for bad news about that person.
Then it tells you what it found, and how sure it is.

It also tells you what it could **not** check. That part matters. A search that missed half the
sources must never look like a clean result.

Rules we never break:

- We only use free and open sources. No paid data.
- We never bypass a CAPTCHA, a login wall, or a paywall.
- We obey each website's `robots.txt` rules.
- If we are not sure a site allows us, we do **not** fetch it.
- We never say "nothing found" when we really mean "we could not look".

---

## 2. What works today

| Thing                                          | Works?                  |
| :--------------------------------------------- | :---------------------- |
| The API (create a search, get results)         | Yes                     |
| Login, tenants, permissions                    | Yes                     |
| Database, background jobs, search index        | Yes                     |
| Full search run end to end                     | Yes, with **fake** data |
| Real HTTP fetching (safe, with all the guards) | Built and tested        |
| Reading RSS news feeds                         | Built and tested        |
| Actually contacting a real website             | **Not yet**             |
| Reading an article and pulling out facts       | Basic keyword only      |

**No real website has ever been contacted by this service.** That is still true today.

Right now the service runs in "mock mode". Everything works, but all the data is fake test data.

---

## 3. You can test it in Postman right now

```
pnpm local:up
pnpm local:bootstrap
pnpm dev:api
```

Then import `openapi/openapi.json` into Postman.

You will get real API responses. The data behind them is fake. Nothing leaves your machine.

---

## 4. What we built this session

Six pieces of work. Here is each one in one line.

**1. An XML reader for news feeds.**
News feeds are XML. XML can be used to attack us — a bad feed can trick a normal XML reader into
reading files off our server, or into using up all our memory. Both attacks need one special tag
at the top of the file. So we check for that tag first and throw the whole file away if it is
there. Simple rule, ours, easy to test.

**2. A second circuit breaker.**
We already had one: if a _source_ keeps failing, stop calling it. But one news feed links to a
hundred different websites. If one of those websites blocks us, that is about that website — not
about the feed. So now we track websites separately. One bad website no longer shuts off a good
feed.

**3. Stop rules for each source.**
Some sites tell you exactly what their limits are. The SEC says: 10 requests per second max, and
if you send a request without naming yourself, we block you for 10 minutes. So we wrote their
rules down and made the code follow them:

- Get a 403? Stop completely. A person has to look at it before we start again.
- Get a 429 (too many requests)? Wait exactly as long as they asked, then stop.
- Three server errors in a row? Stop.
- Daily request cap as a backstop.
- Kill switch anyone can pull.

All five are tested and proven to work.

**4. Every source needs a named approval.**
Before this service talks to any website for the first time, a real person has to sign off — by
name, with the date. Not just "the config looks right". Someone accepts responsibility for
contacting that website.

This means: you can add a hundred sources to the system, and **none of them will be contacted**
until you approve each one by name. That is on purpose.

**5. The product is now worldwide.**
It used to be Costa Rica only. You changed that. The code supports it. One honest warning below
in section 6.

**6. The RSS feed reader.**
One piece of code that can read **any** RSS feed. Which feeds it reads comes from the database,
not from the code. Adding a news source is an approval, not a code change and a deploy.

---

## 5. Test results

```
Code style        clean
Type checking     clean
Unit tests        754 passing   (was 644 when the session started)
Safety rules      29 passing
Quality metrics   12 passing
```

No test opens a real internet connection.

---

## 6. What is NOT done yet — read this part

**The cascade is not built.**
We have a feed reader, but nothing that runs through all the sources in order and says "I tried
source 1, then 2, then 3, and here is what each one gave me". That is the next job.

**Reading articles is very basic.**
Right now we only match keywords. So even after we start fetching real articles, the results will
be thin at first. The service will say so in the results instead of pretending.

**We do not know how good our search is.**
We have never measured how many real results we find versus how many we miss. Until we measure
that, every result carries a warning saying so. Going worldwide makes this bigger, not smaller —
more languages, still zero measured.

**No source is approved for live use yet.**
The SEC feed is written down and ready. It has not been switched on.

---

## 7. What happens next

In this order:

1. **Build the cascade.** Run through all approved sources in order, log each step, report gaps.
2. **You send the source list.** Format below.
3. **First real request.** One single request to `https://www.sec.gov/robots.txt` to read their
   rules. We prepare it. You press the button. Nothing else goes out.
4. **Turn on one feed.** Check it every 15 minutes. Watch it for a few cycles.
5. **Add more sources**, one approval at a time.

---

## 8. What we need from you

A list of sources. Any format. One per line is fine:

```
Source name | feed URL | countries | languages | type
```

Example:

```
Reuters World News | https://example.com/rss/world | US, GB | en | news
```

Types: `news`, `gazette` (official government notices), `court`, `regulator`.

**Why we are asking instead of finding them ourselves:** we will not put a guessed URL into the
system. A guessed URL is a made-up fact sitting in a record that a person signs their name to.
We only write down addresses we know are real.

---

## 9. Words you will see in the docs

| Word                 | Means                                            |
| :------------------- | :----------------------------------------------- |
| **Source**           | A website or feed we search                      |
| **Lead**             | A headline and a link. Not proof of anything yet |
| **Finding**          | A real result, after we read the article         |
| **Coverage**         | What we checked and what we could not check      |
| **Breaker**          | Auto-stop when something keeps failing           |
| **Kill switch**      | Manual stop. One person, works immediately       |
| **Mock mode**        | Fake data. Nothing leaves your machine           |
| **Live mode**        | Real websites. Not switched on yet               |
| **Gate**             | The checks a request must pass before it is sent |
| **D-number** (D-041) | A decision we wrote down, with the reasons       |

---

## 10. Where to look for more

| File                            | What is in it                      |
| :------------------------------ | :--------------------------------- |
| `docs/SIMPLE-FLOW.md`           | The same thing, as diagrams        |
| `docs/INTEGRATION-AUDIT.md`     | HubSpot + SharePoint: audit + plan |
| `docs/execution/START-HERE.md`  | Where the work is up to right now  |
| `docs/execution/handoff-log.md` | What each work session did         |
| `docs/decisions.md`             | Every decision and why we made it  |
| `docs/open-decisions.md`        | Decisions still waiting on someone |

Those files are detailed and long. This one is the summary.
