# Routines

A [Mirador](https://github.com/sodre90/mirador) plugin that runs a prompt in a workspace on a schedule you set.

Each routine is a name, a profile, what the agent should do, what you want to be able to see when it ends, and when it
runs: weekdays, every day, chosen days at a time, every few hours, or a cron line. When one is due, Mirador starts a
fresh conversation for it in the workspace, which works on the message and then waits for you like any other: a *Done*
mark in the sidebar, a notification, a place in the phone app. Slots missed while the Mac slept come back as one run, so
a weekday routine set for 09:00 runs once on Monday morning, not five times.

The workspace's **Routines** tab lists them with when they next run, takes the edits, starts one now, and keeps the
recent runs with how each ended.

## Develop

    bun install
    bun run test          # the schedule and the plugin's work
    bun run typecheck

`e2e/routines-plugin.spec.ts` drives the tab in a real Mirador; it needs Mirador's own e2e helpers, so it runs from a
Mirador checkout, as its header says.

Try it in your own Mirador:

    ln -s "$PWD" ~/.mirador/plugins/routines

Mirador loads it from its next start (`⌘⇧R` in a conversation on this computer).
