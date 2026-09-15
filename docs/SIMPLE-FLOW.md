# How the data flows — in pictures

Last updated: 2026-09-15

Companion to [`SIMPLE-STATUS.md`](./SIMPLE-STATUS.md). That one says what is built. This one
shows how things move.

Two views of the same system:

- **Today** — what really happens when you press send in Postman right now.
- **Live** — what happens once real sources are switched on.

---

## 1. Today — mock mode

This is what runs on your machine right now. Nothing leaves the machine.

```mermaid
flowchart LR
    subgraph you["YOUR SIDE"]
        P[Postman]
    end

    subgraph svc["OUR SERVICE"]
        API[API]
        DB[(Database)]
        Q[Job queue]
        W[Worker]
        PL[Pipeline]
    end

    subgraph fake["FAKE DATA"]
        M[Mock sources<br/>test files on disk]
    end

    P -->|1 - POST a search| API
    API -->|2 - save + queue| DB
    API --> Q
    API -->|3 - return search id| P
    Q --> W
    W --> PL
    PL <-->|4 - ask for data| M
    PL -->|5 - write findings| DB
    P -->|6 - GET the search| API
    API -->|7 - findings + coverage| P
```

**The short version:** you ask, we answer immediately with an id, a worker does the real work in
the background, you come back and read the result.

**Steps 1 to 3 are fast on purpose.** We do not make you wait while the search runs.

---

## 2. Live — what it will look like

Same left half. The right half changes: fake files become real websites, and a safety gate
appears in between.

```mermaid
flowchart LR
    subgraph you["YOUR SIDE"]
        P[Postman]
    end

    subgraph svc["OUR SERVICE"]
        API[API]
        DB[(Database)]
        W[Worker]
        PL[Pipeline]
        C[Cascade<br/>tries sources in order]
        G{Safety gate}
        F[Fetcher]
    end

    subgraph net["THE INTERNET"]
        S1[News feed]
        S2[Court site]
        S3[Regulator site]
    end

    P -->|POST a search| API
    API --> DB
    API --> W
    W --> PL
    PL --> C
    C --> G
    G -->|refused| GAP[Write down the gap]
    G -->|allowed| F
    F --> S1
    F --> S2
    F --> S3
    S1 --> F
    S2 --> F
    S3 --> F
    F --> PL
    GAP --> DB
    PL --> DB
    P -->|GET the search| API
    API --> DB
```

**The one thing to notice:** a refused request does not disappear. It gets written down and shows
up in your results as a gap. You always know what we could not check.

---

## 3. Inside the pipeline

What the worker actually does, in order.

```mermaid
flowchart TD
    A[1 - Load the person<br/>name and any aliases] --> B[2 - Build the search queries]
    B --> C[3 - Find leads<br/>headlines and links]
    C --> D[4 - Decide which are worth fetching]
    D --> E[5 - Fetch the article]
    E --> F[6 - Read it and pull out facts]
    F --> G[7 - Score it]
    G --> H[8 - Write findings + coverage]

    C -.->|source refused or failed| GAP[Gap recorded]
    E -.->|blocked or too big| GAP
    F -.->|could not read it| GAP
    GAP --> H
```

**A lead is not a finding.** A headline is a claim about an article. Until we fetch and read the
article, it stays a lead.

---

## 4. The safety gate

Every single request to a real website passes through this, in this order. If any step says no,
no connection is opened.

```mermaid
flowchart TD
    START[We want to fetch a URL] --> Q1{Is the source approved<br/>and did a person sign off?}
    Q1 -->|no| STOP1[Refuse]
    Q1 -->|yes| Q2{Is the URL safe?<br/>https only, public address only}
    Q2 -->|no| STOP2[Refuse]
    Q2 -->|yes| Q3{Is this website<br/>currently blocking us?}
    Q3 -->|yes| STOP3[Refuse]
    Q3 -->|no| Q4{Does robots.txt allow it?}
    Q4 -->|no or unsure| STOP4[Refuse]
    Q4 -->|yes| Q5{Budget left today?<br/>Kill switch off?}
    Q5 -->|no| STOP5[Refuse]
    Q5 -->|yes| GO[Open the connection]

    STOP1 --> REC[Write down the reason]
    STOP2 --> REC
    STOP3 --> REC
    STOP4 --> REC
    STOP5 --> REC
```

**Unsure means no.** If a website is down and we cannot read its `robots.txt`, we do not fetch.
A site being offline is not the same as a site saying yes.

---

## 5. What happens when something goes wrong

```mermaid
flowchart TD
    E[A request fails] --> C{What kind of failure?}

    C -->|Page not found| D1[Just that one page.<br/>Move on.]
    C -->|Temporary network error| D2[Wait, try again.<br/>Up to 5 times.]
    C -->|Too many requests - 429| D3[Wait exactly as long<br/>as they asked. Then stop.]
    C -->|Forbidden - 403| D4[Stop completely.<br/>A person must look.]
    C -->|Site down 3 times in a row| D5[Stop completely.]

    D3 --> HALT[Source is halted]
    D4 --> HALT
    D5 --> HALT
    HALT --> REL[Restarting needs a<br/>different person to approve]
```

**Two different levels of stopping:**

- **Breaker** — automatic, temporary. Comes back on its own after a cooldown.
- **Halt** — a person has to look at it and a second person has to restart it.

---

## 6. Adding a new source

No code change. No deploy.

```mermaid
flowchart LR
    A[Someone proposes<br/>the source] --> B[A second person<br/>approves it]
    B --> C[A named person signs off<br/>on contacting the website]
    C --> D[Read their robots.txt<br/>once, by hand]
    D --> E[Record what it said]
    E --> F[Source goes live]
```

**Step C is separate from step B on purpose.** Step B says "the settings are correct". Step C
says "I accept that we will start contacting this website". Different things, different
signatures.

Until step C is done, the source sits in the system fully configured and **never gets contacted**.

---

## 7. Today vs live — side by side

|                               | Today                    | Live                     |
| :---------------------------- | :----------------------- | :----------------------- |
| Where data comes from         | Test files on disk       | Real websites            |
| Requests leaving your machine | None                     | Only to approved sources |
| Safety gate                   | Runs, always passes      | Runs, can refuse         |
| Results                       | Real shape, fake content | Real                     |
| Speed                         | Instant                  | Depends on the sites     |
| Coverage gaps shown           | Yes                      | Yes                      |

The **shape** of everything is the same in both. That is deliberate. Switching to live does not
change the flow, only what is at the far end of it.

---

## 8. Where we are on this diagram right now

| Part                                  | Built?          |
| :------------------------------------ | :-------------- |
| Postman to API to worker to results   | Done            |
| Pipeline steps 1, 2, 7, 8             | Done            |
| Safety gate, all five checks          | Done and tested |
| Failure handling and stopping         | Done and tested |
| Reading RSS feeds                     | Done and tested |
| Cascade - trying sources in order     | **Not built**   |
| Pipeline steps 4, 5, 6 with real data | **Basic only**  |
| Any real website contacted            | **Never**       |
