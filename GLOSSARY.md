# Chore App

A family chore management system in which household members record chore completions by tapping NFC tags placed where the chore happens.

## Households and people

**Household**:
A group of people who share a set of chores and tags, operating in a single time zone.
_Avoid_: Family, home, group

**Person**:
An individual with their own login, who may belong to more than one Household.
_Avoid_: User, account

**Membership**:
A Person's belonging to a specific Household, carrying a Role; it can be ended, but the Person's past Completions remain attributed to them.

**Role**:
What a Membership permits; either Admin or Standard.

**Admin**:
A Role that can manage the Household, its Chores, its Tags and its Memberships, and void any Completion.

**Standard**:
A Role that can complete and view the Household's Chores but not manage them.
_Avoid_: Member, child, user

**Invite**:
A one-time link or code an Admin issues to enrol a Person into a Household on their device.

## Chores and scheduling

**Chore**:
A household responsibility, such as "empty the dishwasher", that falls due according to its Schedule and is never closed by being completed.
_Avoid_: Task, job

**Archived**:
The state of a Chore that no longer falls due and whose history is retained; Chores with Completions are archived, never deleted.

**Schedule**:
The rule that determines when a Chore's Occurrences fall due; either Fixed, Interval or One-off.
_Avoid_: Recurrence, frequency

**Fixed Schedule**:
A Schedule whose Occurrences follow the calendar regardless of when (or whether) earlier ones were completed.

**Interval Schedule**:
A Schedule whose next Occurrence falls due a set period after the previous Completion.

**One-off Schedule**:
A Schedule with a single Occurrence that stays Open until completed and is never Missed.

**Time Slot**:
A named time of day within a Fixed Schedule (such as Morning or Evening), each producing its own Occurrence.
_Avoid_: Shift, session

**Occurrence**:
A single instance of a Chore falling due, with a due date and a status of Open, Completed, Missed or Skipped.
_Avoid_: Instance, iteration

**Due Time**:
The moment by which an Occurrence is expected to be completed: its Time Slot's start time, or otherwise the end of its due date.

**Grace Period**:
A fixed 30-minute allowance, applying only to Time Slots, after a Due Time during which a Completion still counts as on time.

**Window**:
The period during which a Fixed-Schedule Occurrence can be completed, running from its due date until the next Occurrence's due date.

**Missed**:
The status of a Fixed-Schedule Occurrence whose window passed without a Completion; it can no longer be completed.
_Avoid_: Skipped, overdue

**Pause**:
A period during which a Chore's Occurrences do not fall due.
_Avoid_: Hold, vacation mode

**Skipped**:
The status of an Occurrence that was not expected to be completed, because it fell within a Pause or was Excused; distinct from Missed.
_Avoid_: Cancelled

**Excuse**:
An Admin's act of marking an Open or Missed Occurrence as Skipped, with a note.
_Avoid_: Forgive, waive

**Assignee**:
The Person expected to complete a given Occurrence, taken from its Time Slot or Chore; an expectation, not a permission.
_Avoid_: Owner

## Tags and completion

**Tag**:
A registered physical NFC tag belonging to one Household, pointing at zero or one Chore at a time.
_Avoid_: Sticker, chip

**Unregistered Tag**:
A Tag URL the system has never seen, which an Admin can claim for their Household by scanning it.

**Scan**:
A Person opening a Tag's URL, which attempts to complete the Chore's currently due Occurrence.
_Avoid_: Tap

**Completion**:
The record that a specific Person (the Completer) completed a specific Occurrence at a specific time by a specific Method, and via which Tag when the Method is NFC.
_Avoid_: Check-off, done-event

**Late**:
A Completion recorded after its Occurrence's Due Time (plus any Grace Period) but within its Window.
_Avoid_: Overdue completion

**Completer**:
The Person credited with a Completion.
_Avoid_: Doer

**Recorder**:
The Person who entered a Completion; differs from the Completer only when an Admin records one on someone's behalf.

**Early Completion**:
A Completion deliberately recorded for an Occurrence that is not yet due.

**Method**:
How a Completion was recorded: NFC or Manual.

**Undo**:
The completing Person's withdrawal of their own Completion shortly after recording it.

**Void**:
An Admin's cancellation of a Completion, which reopens its Occurrence while keeping the voided record in history.
_Avoid_: Delete, revert
