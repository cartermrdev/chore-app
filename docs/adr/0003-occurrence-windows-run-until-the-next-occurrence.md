# Occurrence Windows run until the next Occurrence

Occurrences are stored records, not computed on the fly. A Fixed-Schedule Occurrence's Window runs from its due date (or Time Slot start) until the next Occurrence's due date. When the Window closes without a Completion, the Occurrence becomes Missed, and a Scan always completes the earliest Open Occurrence that is due. This makes "one Completion per Occurrence" the only rule needed to prevent duplicate completions, with no per-chore settings or cooldown timers. It also tolerates sloppy timing: a Scan at 14:00 still completes the Morning slot. Lateness is tracked separately, by comparing the Completion time with the Due Time and Grace Period, which keeps the "done late" signal parents need without creating extra Missed records.

## Considered Options

- **Explicit start/end windows per Occurrence or slot**: rejected because they create gaps where a Scan finds nothing due, and they add configuration to every chore.
- **Cooldown after each Completion**: rejected because it doesn't tie a Completion to a specific Occurrence, which the history and future rewards both need.
- **Computing Occurrences on the fly from the Schedule**: rejected because Missed, Skipped, Excused and per-Occurrence Assignees all need stored state, and Schedule edits must not rewrite the past.
