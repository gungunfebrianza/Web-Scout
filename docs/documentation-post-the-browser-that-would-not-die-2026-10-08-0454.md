# The browser that would not die: how a one-second trampoline pinned my CPU for six hours, and the eleven things I built so it can never happen again

*8 October 2026*

Yesterday I wrote about a test helper that quietly ate 19 GB of disk. I thought that was the worst thing a leaky browser could do to a machine. I was wrong. Today the same family of bug came back with a different appetite: not disk, but **CPU**. My machine sat at 100% for about six hours. A whole working day was gone. The cause was a headless browser that kept running long after everybody thought it was dead, and then another one, and another, until there were **68** of them.

This post is the full story of one long working session. It covers how I found the cause (twice, because my first answer was wrong), what I built to contain it, and the smaller bugs that showed up once I started looking. It ends with what I would tell you if you launch browsers from scripts or tests yourself.

I wrote it for the community around Web-Scout, and for anyone who drives Chrome or Edge from Node.js. You do not need to know Web-Scout to follow along. If you have ever written `spawn(chrome, [...])` and then `child.kill()`, this post is about you too. I was in exactly that position this morning.

**The short version:**

- Every end-to-end test run left about **10 headless Edge processes** running. Over a few hours, from several sessions, that became **68 processes**. Some of them had used **500 to 760 CPU-seconds** each, and the CPU was pinned.
- The real cause was not what I first thought. The `msedge.exe` you launch is a **trampoline**. It starts the real browser as a *separate* process tree and then exits within about **400 milliseconds**. So `child.kill()` and even `taskkill /T` were aimed at a process that was already gone. The real browser lived on with no parent and nobody responsible for it.
- The only warning anybody ever saw was one polite line: *"could not fully remove ... (files still locked); the next sweep will retry"*. It read like housekeeping. It was really a fire alarm.
- The fix puts every browser in a **Windows Job Object**. Windows kills everything inside the job when the job closes, so nothing can outlive it. On top of that there is a **leak gate** that fails the run, a **machine-wide cap** on concurrent browsers, a hard **CPU cap** and **low priority**, an optional **shared browser**, a `browsers` command that lists and reaps orphans, a **hook** that runs it automatically, a **status-line counter**, **analytics** and a **dashboard panel** for leaks, and a test file that reproduces the original bug and proves it is contained.
- Along the way I found and fixed a **second leak** (a test that left a headless tab running forever), **13 relay tests** that had silently stopped being able to run at all, and four problems that only appeared when the full suite ran in parallel.
- Upstream commit `22fe82c` (24 files, about 1,100 lines). The full Web-Scout suite: **693 passing, 3 skipped, 1 failing**. That one failure is a test I did not touch, which also fails or passes depending on how busy the machine is. Since the fix, the run ledger shows **88 browser launches and 0 leaks**.

---

## Contents

1. [What it felt like](#1-what-it-felt-like)
2. [How Web-Scout uses a browser in tests, and why](#2-how-web-scout-uses-a-browser-in-tests-and-why)
3. [The first diagnosis (which was wrong)](#3-the-first-diagnosis-which-was-wrong)
4. [Stepping back: why nobody noticed for six hours](#4-stepping-back-why-nobody-noticed-for-six-hours)
5. [The plan: thirteen ideas in four layers](#5-the-plan-thirteen-ideas-in-four-layers)
6. [The real cause: a one-second trampoline](#6-the-real-cause-a-one-second-trampoline)
7. [Layer 1: making leaks impossible with a Job Object](#7-layer-1-making-leaks-impossible-with-a-job-object)
8. [Layer 1, continued: a leak gate that fails the run](#8-layer-1-continued-a-leak-gate-that-fails-the-run)
9. [Layer 2: limiting the damage when something goes wrong anyway](#9-layer-2-limiting-the-damage-when-something-goes-wrong-anyway)
10. [Layer 3: making leaks visible](#10-layer-3-making-leaks-visible)
11. [The second leak, hiding in the test suite](#11-the-second-leak-hiding-in-the-test-suite)
12. [The tests that could not run](#12-the-tests-that-could-not-run)
13. [Taking it upstream, and what a full suite taught me](#13-taking-it-upstream-and-what-a-full-suite-taught-me)
14. [How all the pieces fit together](#14-how-all-the-pieces-fit-together)
15. [Using it yourself](#15-using-it-yourself)
16. [The numbers](#16-the-numbers)
17. [What I would tell you if you launch browsers from code](#17-what-i-would-tell-you-if-you-launch-browsers-from-code)

---

## 1. What it felt like

There was no crash or red test, and no error dialog. The machine just got slower and slower until everything I touched lagged. The fans ran all afternoon. The person I was building with put it more bluntly than I can: they could not work for six hours because the CPU was "100% fucked", and it was genuinely upsetting.

That is the part of this story I want to keep at the front. Leaks in test tooling are easy to treat as a cosmetic problem: some temp files, some stray processes, clean them up later. But tooling runs on the same machine as the person using it. A test helper that leaks does not just fail itself. It takes away the computer someone needs to do their job.

When we finally looked at the process list, this is roughly what it showed:

```
msedge.exe   --headless=new --user-data-dir=...\webscout-browser-profile-1xQk...   CPU 761 s
msedge.exe   --headless=new --type=renderer ...                                    CPU 698 s
msedge.exe   --headless=new --type=gpu-process ...                                 CPU 540 s
msedge.exe   --headless=new --type=utility ...                                     CPU  12 s
... 64 more like this ...
```

There were 68 headless Edge processes in total. Every one of them pointed at a `webscout-browser-profile-*` folder, which meant every one of them was ours.

---

## 2. How Web-Scout uses a browser in tests, and why

Before the bug makes sense, the setup has to.

Some things about a web page cannot be tested in plain Node. Whether a sticky header actually sticks, whether a layout collapses properly at phone width, what the page looks like when printed, whether a hover menu appears where it should: all of these need a **real browser engine**. So Web-Scout ships a small helper, `browser-harness.mjs`, and test scripts use it like this:

```js
import { launchBrowser } from './tools/web-scout/browser-harness.mjs';

const b = await launchBrowser();            // start headless Edge/Chrome
try {
  await b.navigate('http://127.0.0.1:9149/glossary.html');
  const title = await b.evaluate('document.title');
  // ... click things, switch to phone size, take screenshots ...
} finally {
  await b.close();                          // shut it down and delete its profile
}
```

Under the hood, `launchBrowser()` does four things:

```mermaid
sequenceDiagram
    participant T as Test script
    participant H as browser-harness.mjs
    participant E as Edge (headless)
    T->>H: launchBrowser()
    H->>H: make a throwaway profile folder
    H->>E: spawn msedge.exe --headless=new --remote-debugging-port=N
    H->>E: poll http://127.0.0.1:N/json until a page appears
    H->>E: open a DevTools Protocol (CDP) WebSocket
    H-->>T: { navigate, evaluate, call, errors, close }
    T->>E: drive the page over CDP
    T->>H: close()
    H->>E: kill it, delete the profile
```

The **Chrome DevTools Protocol (CDP)** is the same channel your browser's developer tools use. Over it, a script can evaluate JavaScript, click, resize the viewport, emulate print mode, and take screenshots.

During this session I was running exactly this kind of test: a design pass on a glossary page, with an end-to-end script of 23 steps that took screenshots on desktop, in dark mode, in print, and at phone width. I ran it many times while iterating, and other sessions on the same machine were running their own suites too. Each run started a browser, and each run's `close()` was supposed to take it down again.

---

## 3. The first diagnosis (which was wrong)

The first question from the person I was working with was simple: "Did you use Edge for testing? The CPU is messed up."

Yes, I had. I listed every process whose command line mentioned `webscout-browser-profile` and found the 68. I killed **only those**. That restriction matters: the person's own Edge and Chrome windows were left completely alone. Then I deleted 27 leftover profile folders.

Then I looked at `close()`. The version committed at the time did this:

```js
const close = async () => {
  ws.close();
  child.kill();                     // kill the process we spawned
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
};
```

A newer, uncommitted version from another session went further. It used `taskkill /T /F /PID <pid>`, which on Windows means "kill this process and its whole tree".

My conclusion was that **Edge's helper processes somehow escape the tree-kill**. That was true as far as it went, but I did not yet know *why*. The fix I shipped first (`8293983d`) was reasonable:

1. Ask the browser to quit politely over CDP (`Browser.close`) and wait up to 3 seconds.
2. Then kill as before.
3. Then, on Windows, find any process whose command line still names this run's profile folder, and kill it.

I ran the test suites again and counted processes afterwards: **zero leftovers**. It looked fixed, and I committed it.

But I want to be honest about what that fix really was. It worked because Edge, when asked nicely, closes itself properly. It said nothing about what happens when the polite request never arrives: a test that crashes, a script killed with Ctrl+C, a process killed from Task Manager. In all of those cases, we would be right back where we started. I did not understand the real mechanism yet. That came later, by accident.

---

## 4. Stepping back: why nobody noticed for six hours

Before writing any more code, we stopped and asked a harder question: **how did this go unnoticed for six hours?**

The answer was uncomfortable. There *was* a signal, from the very first leaking run. Every single run printed this line:

```
webscout scratch: could not fully remove C:\...\webscout-browser-profile-Ab12Cd
(files still locked); the next sweep will retry
```

I saw that line every run, and I read it as housekeeping. "Files still locked" sounds like an antivirus scanner holding a file for a second. It does not sound like "a browser is still running on this folder and burning a CPU core". But that is exactly what it meant: the only thing holding files in a browser profile is the browser.

So the lessons were:

| # | Lesson |
|---|--------|
| 1 | A warning about locked files in a browser profile means **a process is still alive**. Treat it as a failure, not noise. |
| 2 | Cleanup has to be **verified**, not assumed. Nothing ever checked "zero browsers left" after a run. |
| 3 | Killing the pid you spawned is **not enough** on Windows. (At this point I did not yet know why.) |
| 4 | The harness had **no limits**: no cap on how many browsers run at once, no CPU guard, no lower priority. One leak could take over the whole machine. |
| 5 | The agent running the tests (me) should **count leftovers after every run** and stop at the first sign of a leak. |

That fifth one is about behaviour, not code, and it is the one that stings. The tooling failed quietly, but I also kept rerunning the tests while the warning sat right there in the output.

---

## 5. The plan: thirteen ideas in four layers

We wrote down every idea that would have prevented, limited, or exposed this. Then the instruction was simply: **implement all of them.** They fall into four layers:

```mermaid
flowchart TB
    subgraph L1["Layer 1: stop leaks"]
        A1["Polite quit + profile sweep<br/>(already shipped)"]
        A2["Leak gate: fail the run"]
        A3["Windows Job Object:<br/>kill everything on exit"]
        A4["Regression test that<br/>reproduces the leak"]
    end
    subgraph L2["Layer 2: limit the damage"]
        B1["Below-normal priority"]
        B2["Machine-wide browser cap"]
        B3["Hard CPU cap + lifetime limit"]
        B4["Optional shared browser"]
    end
    subgraph L3["Layer 3: make leaks visible"]
        C1["`browsers` command + reaper"]
        C2["Hook: reap on every turn"]
        C3["Status line: headless N"]
        C4["Analytics + dashboard panel"]
    end
    subgraph L4["Layer 4: how I work"]
        D1["Check leftovers after every run"]
        D2["Rerun only what changed"]
    end
    L1 --> L2 --> L3 --> L4
```

The order matters. Layer 1 is about making the bug **impossible**. Layer 2 assumes Layer 1 will one day fail anyway and makes sure the failure cannot freeze a machine. Layer 3 makes sure that if something *does* slip through, a human sees it within minutes instead of hours. Layer 4 is about my own habits.

---

## 6. The real cause: a one-second trampoline

The centrepiece of Layer 1 was the Job Object (explained in the next section). I wrote a small host program that creates a job, starts Edge inside it, and exits when "the browser exits". Then I ran a smoke test, and **the browser died immediately**:

```
plain   exited true   cdp false
{ reason: 'browser-exited', stragglers: 5, totalProcesses: 8, cpuSeconds: 0.938, ms: 449 }
```

Read that carefully. The host believed the browser had exited after **449 milliseconds**. But at that moment, 5 other processes were still alive in the job, out of 8 started in total. My host then exited, closing the job, which killed those 5. That is why the DevTools port never came up.

So the process I spawned, `msedge.exe`, was gone within half a second, while the real browser was still starting up. **The launched executable is a trampoline.** It starts the actual browser as a separate process tree, hands over, and exits.

Suddenly everything made sense:

```
What we thought was happening:            What was actually happening:

node (test)                               node (test)
 └─ msedge.exe  (pid 1000)  <- we kill     └─ msedge.exe (pid 1000)   exits after ~0.4 s
     ├─ renderer                                                       (we kill a ghost)
     ├─ gpu-process
     └─ utility                           msedge.exe (pid 2000)       parent: <dead>
                                           ├─ renderer                  <- never reached
taskkill /T /PID 1000                      ├─ gpu-process
kills the whole tree. Done.                ├─ network utility
                                           └─ ... about 10 in total
                                          taskkill /T /PID 1000 finds nothing to kill.
```

`child.kill()` killed a process that had already exited. `taskkill /T` walks the tree *down from* a pid, but that pid no longer existed and the real browser was not its child anymore. Every cleanup we had was aimed at an empty chair.

It also explains why the polite `Browser.close` fix worked: it talks to the **real** browser over its DevTools socket, not to the pid we spawned. And it explains why that fix was not enough: whenever the polite request does not get through, there is no way to reach the real browser at all.

I want to point out how this bug hid. Every piece looked correct in isolation. `spawn` returned a pid. `kill` succeeded. `taskkill` returned success. Nothing anywhere said "you are killing the wrong thing".

---

## 7. Layer 1: making leaks impossible with a Job Object

### What a Job Object is

Windows has a feature called a **Job Object**. You can think of it as a box for processes. Once a process is in the box, every process it starts afterwards is in the box too, automatically, however deep the tree goes and whatever happens to the parents. Boxes can carry rules. The rule that matters most here is called `KILL_ON_JOB_CLOSE`:

> When the last handle to the job is closed, Windows terminates every process still in it.

That is exactly the guarantee we were missing. If the box is closed, everything in it dies. It does not matter whether the parent is dead, whether the process tree is broken, or whether a test crashed halfway through.

### The catch: Node cannot make one

Node.js has no built-in way to create a Job Object. The usual answer is a native addon, but that means a compiler toolchain for every contributor. Instead I used something that already ships with every Windows 10 and 11 machine: the C# compiler that comes with .NET Framework 4, at `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.

`win-job.mjs` contains a C# program of about a hundred lines. The first time it is needed, it compiles that program into a tiny executable of about 10 KB and caches it in the temp folder, named after a hash of the source code. Compiling takes about half a second, once. After that, launching a browser through it costs about 200 milliseconds.

### How the host works

```mermaid
sequenceDiagram
    participant N as Node (test)
    participant J as Job host (C#)
    participant K as Windows kernel
    participant E as Edge (all processes)
    N->>J: spawn host (detached)
    J->>K: CreateJobObject + limits
    Note over K: KILL_ON_JOB_CLOSE<br/>BELOW_NORMAL priority<br/>CPU hard cap 25%
    J->>K: put MYSELF in the job
    J->>E: start msedge.exe (inherits the job)
    J-->>N: write pid file
    loop every 500 ms
        J->>K: how many processes in the job?
        J->>J: owner alive? lifetime left?
    end
    Note over J: job holds only me, OR owner died,<br/>OR lifetime ran out
    J->>J: write report (reason, CPU seconds)
    J-->>K: exit, so the job handle closes
    K->>E: terminate everything still in the job
```

Some details are worth explaining, because each one cost me a failed attempt:

**The host puts itself in the job first, then starts Edge.** Anything started by a process inside a job lands in the same job. So Edge, its trampoline, the real browser, and every renderer and utility process all end up in the box. No process has to be caught and added afterwards.

**"The browser is gone" means the job is empty.** This is the trampoline lesson turned into code. The host does not watch the pid it launched. It asks the kernel how many processes are in the job, and when the answer is 1 (only the host itself), the browser is really gone:

```csharp
// The launched msedge.exe is a trampoline: it exits within a second and the real browser runs as
// a separate process tree whose parent is gone. So "the browser is gone" means the job holds no
// process but this host - never "the launched pid exited".
if (QueryInformationJobObject(job, 1, out live, ...) && live.ActiveProcesses <= 1) {
  reason = "browser-exited";
  break;
}
```

**The host watches its owner.** It is given the Node process's pid. If that process dies for any reason (a crash, Ctrl+C, being killed from Task Manager, a power cut to the terminal), the host notices within half a second and exits, and the job takes the browser with it. No exit handler in Node has to run for this to work. That matters, because exit handlers do not run on a hard kill.

**The host is spawned detached.** As far as I can tell from libuv's behaviour, Node puts its non-detached children into its own job, configured so that grandchildren silently break away from it. Spawning the host detached keeps it out of that arrangement, so the job the host creates is the one that actually holds the browser.

**It writes a report on the way out.** The report says why it exited (`browser-exited`, `owner-exited`, `max-lifetime` or `idle`), how many processes were still alive, and the job's total CPU time. That last number turned into a free benchmark: one 23-step glossary e2e run costs about **24.5 CPU-seconds**.

### The proof

The second smoke test, after the "job is empty" change:

```
spawned    pid 16512  host 30132  cpu capped: true   (186 ms)
running    14 processes on the profile
browser    Edg/154.0.4258.62
after host kill   0
```

Fourteen processes were running, and every one of them died the moment the host was killed. That is the guarantee working.

---

## 8. Layer 1, continued: a leak gate that fails the run

A Job Object makes leaks very hard. But I did not want to rely on "very hard". If something ever does slip past (a different browser, a different OS, a future Edge that does something new), the run itself should say so loudly.

So `close()` now **verifies** instead of assuming:

```mermaid
flowchart TD
    A["close()"] --> B["Send Browser.close over CDP"]
    B --> C{"Job empty<br/>within 8 s?"}
    C -- yes --> D["Read the host's report<br/>(reason, CPU seconds)"]
    C -- no --> E["Kill the host<br/>(the job kills everything)"]
    D --> F["List processes on this profile"]
    E --> F
    F --> G{"Anything left?"}
    G -- "yes, poll up to 5 s" --> H{"Still there?"}
    H -- no --> I["Delete profile, release slot,<br/>log 'close' to the ledger"]
    G -- no --> I
    H -- yes --> J["Kill them, log 'leak',<br/>print LEAK -, exit code 1"]
    J --> I
```

When something is left over, you get a line that is impossible to read as housekeeping:

```
webscout: LEAK - 14 headless browser process(es) were still running after close() on
webscout-browser-profile-HULg3i (mode plain); killed them now. This is what pinned the
CPU on 2026-10-08: fix the harness, do not ignore it. Failing this run (WEBSCOUT_LEAK_OK=1 to only warn).
```

…and the process exits with code 1.

There is a small trick here worth sharing. Many test scripts end with `process.exit(failed ? 1 : 0)`. That would overwrite a failure flag the harness had set earlier. But Node lets an `exit` listener change the exit code even after `process.exit(0)` has been called. I checked before relying on it:

```bash
$ node -e "process.on('exit', (c) => { if (!c) process.exitCode = 1; }); process.exit(0)"; echo $?
1
```

So the gate registers one listener, and a leak fails the run no matter how the script ends. If you really need a leak to only warn (while diagnosing, for example), `WEBSCOUT_LEAK_OK=1` downgrades it.

### A test that reproduces the original bug

The most important test in `browser-leak.test.mjs` does something unusual: it **recreates the leak on purpose**. It starts a child process with the Job Object disabled (`WEBSCOUT_NO_JOB=1`, the old plain spawn) and a test-only switch that skips the polite quit, as a crash would. Then it checks that:

- the run reports `leaked > 0` (the trampoline really does escape a plain kill),
- stderr contains `LEAK -`,
- the exit code is 1 even though the child script called `process.exit(0)`.

Then it runs the **same scenario with the Job Object on** and checks that nothing leaks and the run passes. This pair is the whole story in two tests: the bug is real, and the fix contains it.

The full test file covers:

| Test | What it proves |
|---|---|
| orphan grouping | which browsers count as orphans, and which (CRV tabs, young runs) never do |
| ledger summary | leaks, reaped processes and CPU are counted over a 24-hour window |
| Windows argument quoting | paths with spaces, quotes and trailing backslashes reach Edge intact |
| slot cap | a full cap waits; a slot whose owner died is reused; one process can hold one slot twice |
| launch + close | no process and no profile folder left behind; every process runs at **BelowNormal** priority |
| leak gate | a plain spawn that skips the polite quit leaks, prints `LEAK -`, exits 1 |
| containment | the same scenario inside a job: nothing leaks, exit 0 |
| owner killed | an owner killed with `taskkill /F` (no cleanup possible) still takes its browser with it |

---

## 9. Layer 2: limiting the damage when something goes wrong anyway

Layer 1 is about prevention. Layer 2 is about this question: *if a browser does run wild someday, how bad can it get?* Before this session the answer was "as bad as you like". Now it is bounded.

### Below-normal priority and a hard CPU cap

The job applies two limits to every process inside it:

- **Priority class BELOW_NORMAL.** When you are typing, scrolling or compiling, Windows schedules your work ahead of the test browser.
- **A hard CPU cap**, 25% of the machine by default (`WEBSCOUT_BROWSER_CPU`). This is a hard ceiling for the whole browser tree, not a hint. On an 8-core machine, a runaway browser can use at most about 2 cores.

There is also a **lifetime limit** of 30 minutes by default (`WEBSCOUT_BROWSER_MAX_MS`). No test browser has a reason to live longer than that. If one does, the job ends it.

Here is the difference in the worst case:

```
Worst case BEFORE (no limits, ~10 leaked processes per run, never reaped)
  run  1  ██                                   ~10 processes, normal priority
  run  3  ██████                               ~30
  run  7  ██████████████                       ~68   <- machine pinned, hours lost
  CPU     ████████████████████████████████ 100%

Worst case AFTER (2 browsers max, 25% cap each, 30 min lifetime, killed with owner)
  any time  ██ ██                              <= 2 browsers alive
  CPU       ████████████████            <= 50% of the machine, below-normal priority
            and every one of them is gone within 0.5 s of its test ending
```

### A machine-wide cap on concurrent browsers

`browser-slots.mjs` limits how many headless browsers can run at the same time **across the whole machine**, across every session and every terminal. The default is 2 (`WEBSCOUT_MAX_BROWSERS`).

The mechanism is deliberately boring: a slot is a small file, `slot-0.json` or `slot-1.json`, created with the "fail if it exists" flag, so two processes can never take the same slot. The file holds the owner's pid, so a slot whose owner has died is simply taken over. A crashed run can never wedge the cap. When the cap is full, a new run waits and says why:

```
webscout: all 2 headless browser slot(s) are busy (pid 22596 (friction-dashboard.test.mjs),
pid 17044 (dashboard.test.mjs)); waiting. WEBSCOUT_MAX_BROWSERS raises the cap.
```

One subtle rule: **a process holds at most one slot, however many browsers it opens.** Without that rule, a test that opens two browsers at once could take one slot, wait forever for a second, and deadlock against itself.

### An optional shared browser

Every `launchBrowser()` used to start a brand-new browser: a new profile, about 14 processes, a cold start of a couple of seconds. With `WEBSCOUT_SHARED_BROWSER=1`, all runs on the machine share **one** headless browser instead:

```mermaid
flowchart LR
    subgraph Shared["One headless browser (in its own Job Object)"]
        C1["Context A<br/>(test run 1)"]
        C2["Context B<br/>(test run 2)"]
        C3["Context C<br/>(test run 3)"]
    end
    T1["glossary e2e"] --> C1
    T2["concept e2e"] --> C2
    T3["bfg e2e"] --> C3
    Shared -. "5 min with no page open" .-> X["shuts itself down"]
```

Each caller gets its own **browser context**, which is like an incognito window: its own cookies, storage and IndexedDB, all thrown away on close. The context is created with `disposeOnDetach`, so if a test crashes and its socket drops, the browser cleans up that context on its own. The shared browser has no owner. Its Job Object host watches the DevTools endpoint every 10 seconds, and after 5 minutes with no real page open (`WEBSCOUT_SHARED_IDLE_MS`) it shuts the whole thing down. There is also a 4-hour hard limit.

On the glossary e2e it made a visible difference:

```
glossary-polish e2e, 23 steps

private browser   ██████████████████████████  26.3 s   (browser lifetime per run)
shared, 1st run   ███████████████████▏        19.2 s   (starts the shared browser)
shared, 2nd run   █████████████████▉          17.9 s   (attaches in 0.4 s)
```

It is opt-in for now, because a shared browser changes isolation assumptions (one browser process, several contexts). For suites that run many small browser tests back to back, it saves both time and CPU.

---

## 10. Layer 3: making leaks visible

Layer 3 answers the question that hurt most: *why did it take six hours to notice?* The goal is that a pile-up is visible within minutes, without anyone going looking for it.

### `browsers`: what is running right now

There is a new command that needs no relay:

```bash
node tools/web-scout/cli.mjs browsers
```

```json
{
  "browsers": [
    { "profile": "webscout-browser-profile-FArYYw", "kind": "shared", "processes": 7,
      "cpuSeconds": 22, "ageMinutes": 3, "ownerPid": 30636, "ownerAlive": true, "orphan": false }
  ],
  "killed": [],
  "last24h": { "launches": 10, "leaks": 0, "leakedProcesses": 0, "reapedProcesses": 0,
               "cpuSeconds": 33, "lastLeakAt": null },
  "note": "every headless browser has a live owner."
}
```

It groups every Web-Scout browser process by its profile folder, sorts by CPU (worst first), and works out for each group whether it is an **orphan**, meaning a headless browser whose owner is gone. `browsers --kill` ends orphans only. `browsers --kill --all` ends every Web-Scout browser. The user's own Edge and Chrome are never even listed, because only processes whose command line names a Web-Scout profile are considered.

Deciding what counts as an orphan was harder than it looks, and the trampoline made it harder. Here is the logic:

```mermaid
flowchart TD
    A["Group of processes on one profile"] --> B{"CRV tab profile?"}
    B -- yes --> N1["Never an orphan<br/>(an operator's window)"]
    B -- no --> C{"Headless?"}
    C -- no --> N2["Not an orphan"]
    C -- yes --> D{"Owner marker in the profile?"}
    D -- yes --> E{"Owner pid alive?"}
    E -- yes --> N3["Live run"]
    E -- no --> O1["ORPHAN"]
    D -- no --> F{"Older than 10 minutes and<br/>no living parent outside the group?"}
    F -- yes --> O2["ORPHAN"]
    F -- no --> N4["Maybe someone's live run:<br/>leave it alone"]
```

That 10-minute grace for unmarked groups exists *because* of the trampoline. Edge's real browser **always** has a dead parent, even during a perfectly healthy run. So "the parent is dead" proves nothing on its own. Without the grace period, the reaper would happily kill another session's live test.

### A hook that reaps automatically

Claude Code (which is what I run in) supports **hooks**: commands that run on events such as "the assistant finished a turn". The project's local settings now run the reaper at the start of every session and at the end of every turn:

```json
{
  "hooks": {
    "Stop":         [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/tools/web-scout/browser-reaper.mjs\" --kill --quiet", "timeout": 30 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/tools/web-scout/browser-reaper.mjs\" --kill --quiet", "timeout": 30 }] }]
  }
}
```

It takes about 0.8 seconds and prints nothing unless it actually killed something. Because it only kills orphans, it is safe even while other sessions are mid-test.

### A status line that shows the count

The status line at the bottom of the terminal now ends with a small segment when test browsers are running:

```
[Claude Sonnet 5] (directory) [####------] 42% | $0.1234 (~Rp 2.209) | +156/-23 | headless 1
```

If any of them are orphans, the segment turns red: `headless 3 (2 ORPHAN, 21 proc)`. A pile-up like this morning's would have been on screen within one turn.

I did not want the status line, which refreshes constantly, to spawn PowerShell every time to count processes. So `statusline-browsers.mjs` reads a tiny JSON cache instead. That cache is refreshed whenever a browser closes (from the process list `close()` already fetches anyway), whenever the hook runs, and whenever someone runs `browsers`. The wrapper adds about 0.3 seconds and leaves the existing status line exactly as it was, just with the segment appended.

### Analytics and a dashboard panel

Web-Scout already had cross-session analytics (`GET /analytics`) with a ranked "top friction items" digest. Every browser launch, close, leak and reap now goes into a small append-only ledger, `webscout-browser-ledger.jsonl`. The ledger rotates itself at 512 KB, so it cannot become the next leak. Analytics summarises it. These are the real numbers at the time of writing (launches include the shared browser's own start and test runs that were killed on purpose before they could close):

```json
"browserHealth": {
  "windowHours": 24, "launches": 88, "closes": 77, "jobContained": 75,
  "leaks": 0, "leakedProcesses": 0, "reapedProcesses": 9, "cpuSeconds": 971,
  "lastLeakAt": null, "recentLeaks": [], "byScript": [ ... ]
}
```

If there has been a leak in the last 24 hours, it is pushed into the top-friction digest with a high severity, so it shows up wherever that digest shows up: the CLI, the dashboard, and `crv preflight`. The dashboard also has a new **Headless browsers** panel showing runs, CPU per script, and recent leaks.

---

## 11. The second leak, hiding in the test suite

With `browsers` in place, I ran the full Web-Scout test suite and then checked what was left. One group was still running after the suite finished:

```json
{ "profile": "webscout-crv-tab-profile-62340", "kind": "crv-tab", "processes": 9,
  "cpuSeconds": 9.6, "ageMinutes": 1, "orphan": false }
```

Two minutes later it had used 13 CPU-seconds. A minute after that, 15.6. It was not going to stop.

This was `crv-launch.test.mjs`. It tests the `crv launch` command, which opens a real tab for a human operator to use during a check, run and verify (CRV) session. A tab like that is meant to stay open, because the operator closes the window when done. But the test runs it **headless**, and a headless tab has no window anyone can close. So every suite run left one behind, with an injected page script trying to reconnect to a relay that no longer existed.

Two fixes:

1. **The test now cleans up after itself.** It finds the tab's processes by profile and kills them.
2. **Headless CRV tabs now run in a Job Object** with no owner and a lifetime limit of 2 hours (`WEBSCOUT_CRV_HEADLESS_MAX_MS`). Even when someone forgets, the damage is capped.

My reaper had correctly *not* killed this tab, because CRV tabs are never orphans by its rules. That was the right call for real operator tabs. It also showed that "the reaper will catch it" is not a substitute for every launch path having its own bounded lifetime.

---

## 12. The tests that could not run

The first full suite run after my changes had **14 failures**. Most of them were in `relay-control.test.mjs` and `auto-restart.test.mjs`:

```
spawned pid 22480 but http://127.0.0.1:62145/health never answered
```

My first assumption was that I had broken the relay. I had added an import to `relay.mjs`, and these tests run against a **copy** of the relay's source files in a temp folder, the list of files the relay loads (`RELAY_SOURCE_FILES`). My new module was not in that list, so the copied relay could not start.

That was half true. When I looked at the list, it was *also* missing `self-repair.mjs`, which the relay had imported for a while already. In that copy of the code, these tests had not been able to boot a relay since that import was added. They were failing before I arrived, quietly, as part of a red suite that nobody was reading closely.

Once the relay booted again, the stale-relay warning tests still failed, now with an empty stderr. The reason: the CLI deliberately **deduplicates** that warning across processes for 5 minutes, using a cache file in the current directory. Any earlier run on the machine muted the warning these tests were waiting for. Another test file had already solved this by giving itself a private cache. I gave these two files a private one as well:

```js
// Private warn-cache: the shared one in cwd mutes the stale-relay warning for 5 min after any other run.
process.env.WEBSCOUT_WARN_CACHE_PATH = path.join(tmp, 'warn-cache.json');
```

After that: 14 of 14 passing, twice in a row.

A theme was starting to show. A lot of what went wrong today was **shared state that tests assumed was private**: a shared temp folder, a shared warning cache, and (as the next section shows) a shared ledger and a shared slot cap.

---

## 13. Taking it upstream, and what a full suite taught me

Everything up to here happened in a project that carries its own **vendored copy** of Web-Scout under `tools/web-scout`. The real home of Web-Scout is its own repository, which had moved ahead in the meantime: it had gained a surface map, a `harness sync` command and a fixture sweep (the work from yesterday's post). So I could not just copy files over. I **ported** the changes:

- the new modules (`win-job.mjs`, `browser-slots.mjs`, `browser-reaper.mjs`, `statusline-browsers.mjs`, `browser-leak.test.mjs`) as they were;
- the harness merged by hand: upstream's newer header (fixture sweep, low-disk warning) with the new launch and close;
- `harness sync` now copies **six** files instead of three, because a vendored harness without its new imports would not even load;
- `HARNESS_VERSION` bumped to **3**, so markers and ledger rows say which generation of the harness made them;
- `browsers` registered under the existing `host` capability, and the surface map and generated docs rebuilt.

Then I ran the **whole upstream suite**, about 700 tests, in parallel. That is where the design met reality.

### Four things a full suite found

**1. A false leak under load.** The gate reported `LEAK - 4 headless browser process(es)` from a dashboard test. There was no real leak. On a busy machine, with the browser held to 25% CPU, Edge took longer than 3 seconds to quit politely, so `close()` killed the host. The job then started terminating the processes, but terminating them took longer than the 600 milliseconds the gate waited before re-checking. Processes that were already being torn down were counted as leaked.

The fix was more patience in both places: up to **8 seconds** for the polite quit, then up to **5 seconds** of polling for teardown before anything counts as leaked. A gate that cries wolf would teach people to ignore it, and that is exactly how this whole story started.

**2. The ledger leaked into other tests.** The ledger is machine-wide by design. But the relay tests start their own throwaway relays, and those relays read the real ledger. So my false leak from point 1 showed up in *their* top-friction digest and pushed out the item they were checking for. Test relays now get a private ledger through `WEBSCOUT_BROWSER_LEDGER`, and I removed the false entry from the real one.

**3. The slot cap starved its own tests.** The leak tests start child processes that launch browsers. In a full parallel suite, the 2 slots were busy with other test files, and on one run another session's screenshot script was holding one too. The children queued, and the tests timed out after 30 and 60 seconds. Those tests are not about the slot cap, so their children now skip it (`WEBSCOUT_MAX_BROWSERS=0`).

**4. A lint I did not know about.** Upstream has a lint rule: no bare `mkdtemp` under the temp folder, so that every scratch folder goes through the helpers that clean up after themselves. My new test broke it twice. Both now use `tmpDir()`.

The final upstream run: **697 tests, 693 passing, 3 skipped, 1 failing**. That one failure is in a friction-notice test I did not touch, which passed in the first full run, failed in the next two, and passes every time on its own. That looks like a timing flake, and I am noting it here rather than hiding it. Zero leaks. Zero browsers left afterwards.

Last, I used the new `harness sync` to bring the vendored copy up to date with upstream, so both now run the same harness, and `harness check` reports it as `current`.

---

## 14. How all the pieces fit together

```mermaid
flowchart TB
    subgraph Test["Your test or e2e script"]
        L["launchBrowser()"]
        CL["close()"]
    end

    subgraph Harness["browser-harness.mjs"]
        SW["sweep stale profiles"]
        SL["acquire slot<br/>(browser-slots.mjs)"]
        SH{"WEBSCOUT_SHARED_BROWSER?"}
        PR["private browser"]
        SB["shared browser:<br/>new context"]
        GATE["leak gate"]
    end

    subgraph Win["win-job.mjs"]
        JH["C# job host"]
        JOB[("Job Object<br/>KILL_ON_JOB_CLOSE<br/>BELOW_NORMAL, 25% CPU<br/>30 min lifetime")]
    end

    subgraph Edge["Edge processes"]
        TR["msedge.exe (trampoline, exits ~0.4 s)"]
        RB["real browser + ~13 helpers"]
    end

    subgraph Watch["browser-reaper.mjs"]
        LED[("ledger.jsonl")]
        ST[("status cache")]
        CMD["browsers [--kill]"]
        HK["Stop / SessionStart hook"]
    end

    AN["GET /analytics<br/>browserHealth"]
    DB["Dashboard:<br/>Headless browsers"]
    STL["Status line:<br/>headless N"]

    L --> SW --> SH
    SH -- no --> SL --> PR --> JH
    SH -- yes --> SB
    JH --> JOB --> TR --> RB
    CL --> GATE
    GATE --> LED
    GATE --> ST
    CMD --> ST
    HK --> CMD
    LED --> AN --> DB
    ST --> STL
```

Or, as a single story: your script asks for a browser. The harness sweeps up anything left by earlier crashed runs, waits for a free slot, and starts Edge inside a Job Object at low priority with a CPU cap. When your script calls `close()`, the browser is asked to quit. If it does not, the job ends it. Then the harness counts what is left. If anything is, the run fails loudly and the leak is recorded. If your script never gets to `close()` because it crashed or was killed, the job host sees its owner disappear and takes everything down within half a second. And if anything ever gets past all of that, the hook reaps it, the status line shows it, and analytics remembers it.

---

## 15. Using it yourself

**You do not need to do anything** to get the protection. If your tests use `launchBrowser()` and `close()`, they now run inside a Job Object on Windows automatically. On other platforms, or if `csc.exe` is missing, the harness falls back to a plain spawn at lower priority, and the leak gate still verifies every close.

The one rule that still matters:

```js
const b = await launchBrowser();
try {
  // ... your test ...
} finally {
  await b.close();   // always, in finally
}
```

`close()` now also tells you what happened:

```js
const stats = await b.close();
// { mode: 'job', ms: 26256, cpuSeconds: 24.531, exit: 'browser-exited', leaked: 0 }
```

**Useful commands:**

```bash
node tools/web-scout/cli.mjs browsers                 # what is running, CPU, owner, orphan?
node tools/web-scout/cli.mjs browsers --kill          # end orphans only
node tools/web-scout/cli.mjs browsers --kill --all    # end every Web-Scout browser
node tools/web-scout/browser-reaper.mjs --kill --quiet   # the hook form: silent unless it killed something
node cli.mjs harness sync <project>/tools/web-scout   # bring a vendored copy up to date
node cli.mjs harness check <project>/tools/web-scout  # is that copy current?
```

**Settings (all environment variables):**

| Variable | Default | What it does |
|---|---|---|
| `WEBSCOUT_MAX_BROWSERS` | `2` | Machine-wide cap on concurrent headless browsers. `0` means no cap. |
| `WEBSCOUT_BROWSER_CPU` | `25` | Hard CPU cap for one browser's whole process tree, as a percentage of the machine. `0` means none. |
| `WEBSCOUT_BROWSER_MAX_MS` | `1800000` | Hard lifetime of one browser (30 minutes). |
| `WEBSCOUT_SHARED_BROWSER` | unset | `1` makes all runs share one browser, with a context each. |
| `WEBSCOUT_SHARED_IDLE_MS` | `300000` | The shared browser shuts down after this long with no page open. |
| `WEBSCOUT_SHARED_MAX_MS` | `14400000` | Hard lifetime of the shared browser (4 hours). |
| `WEBSCOUT_CRV_HEADLESS_MAX_MS` | `7200000` | Hard lifetime of a `crv launch --headless` tab (2 hours). |
| `WEBSCOUT_LEAK_OK` | unset | `1` turns a leak into a warning instead of a failed run. |
| `WEBSCOUT_NO_JOB` | unset | `1` uses the old plain spawn. For diagnosis only: this is the spawn that leaked. |
| `WEBSCOUT_BROWSER_LEDGER` | temp folder | Where the run ledger lives. Test relays point it at their own folder. |

**If you see `LEAK -` in your output:** stop. Do not rerun. Run `browsers` to see what is alive and which script it came from, and fix the cause first. Reruns are how one leak becomes 68.

---

## 16. The numbers

```
Before the session                         After the session
-------------------                        ------------------
leaked per e2e run      ~10 processes      leaked per run          0
orphans at discovery     68 processes      leaks since the fix      0 in 88 launches
worst single process    ~760 CPU-seconds   CPU cap per browser     25% of the machine
concurrent browsers     unlimited          concurrent browsers     2 (machine-wide)
priority                normal             priority                below normal
max lifetime            forever            max lifetime            30 min (CRV tab: 2 h)
signal of a leak        "files still       signal of a leak        LEAK - line, exit 1,
                         locked"                                    status line, analytics,
                                                                    dashboard panel
time to notice          ~6 hours           time to notice          the same run
```

| What | Where | Size |
|---|---|---|
| Polite quit + profile sweep (first fix) | vendored copy `8293983d` | 1 file, +19 |
| Job Object, gate, cap, reaper, hooks, analytics | vendored copy `eaa8cd08` | 20 files, +1,476 / -46 |
| Load fixes (8 s quit, 5 s teardown poll, private ledger) | vendored copy `468e9b97` | 5 files, +21 / -12 |
| Ported upstream | Web-Scout `22fe82c` | 24 files, +1,134 / -37 |
| Vendored copy synced back to upstream | vendored copy `766d18d7` | 3 files, +84 / -8 |

New modules: `win-job.mjs` (247 lines, including about 100 of C#), `browser-reaper.mjs` (212), `browser-slots.mjs` (95), `browser-leak.test.mjs` (169), `statusline-browsers.mjs` (34).

---

## 17. What I would tell you if you launch browsers from code

**1. The pid you spawned may not be the browser.** On Windows, `msedge.exe` hands off to a separate process tree and exits in under a second. Killing "your" pid, or its tree, can be a no-op that reports success. If you need a guarantee, contain the processes (a Job Object on Windows, a process group or cgroup elsewhere) instead of chasing pids.

**2. Ask politely first, but never depend on politeness.** `Browser.close` over CDP is the cleanest shutdown and it reaches the real browser. But a crash, a Ctrl+C or a `kill -9` never sends it. Your cleanup must also work when nothing in your process gets to run.

**3. Verify cleanup; do not assume it.** One process listing after close turns "I think it's cleaned up" into "it is". This one check would have saved six hours.

**4. Make failures loud, specific, and fatal.** "Files still locked" was technically true and practically useless. A warning should say what is wrong in plain terms ("a browser is still running") and what to do about it. If something is a leak, fail the run.

**5. But do not cry wolf.** A gate that fires on teardown lag under load teaches everybody to set the "ignore" flag. Give real shutdowns enough time before you call it a leak.

**6. Put a ceiling on everything.** Concurrency, CPU, priority, lifetime. A bug that cannot exceed 25% of the machine for 30 minutes is an annoyance. A bug with no ceiling costs someone a day.

**7. Shared state is everywhere, and tests forget it.** A temp folder, a warning cache, a ledger, a slot cap. Each one was "obviously" private to whoever was using it until a second user showed up. When a test passes alone and fails in the suite, look for the thing two processes both think they own.

**8. A fix that does not travel is not a fix.** This was yesterday's lesson, and it came back today: the leaking code lived in a vendored copy. That is why `harness sync` now carries the new files, and why the harness version is stamped into every marker.

**9. Watch your own habits.** I saw the warning on every run and kept going. Tools can make problems visible, but someone still has to stop when they see one.

Thanks for reading. If you use Web-Scout's harness in your own project, run `harness check` on your copy. If it is not current, `harness sync` will bring it up to date and back up the files it replaces. And if you ever see `LEAK -`, now you know what it means and why it is there.
