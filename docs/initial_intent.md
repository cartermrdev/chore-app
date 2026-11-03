# Project Intent: NFC-Enabled Family Chore Management Application

## 1. Project Overview

Develop a family chore management application that simplifies the process of assigning, tracking, and completing household chores through the use of NFC (Near Field Communication) technology.

The application will allow household members to mark chores as completed by tapping an NFC tag placed at the physical location associated with the chore, such as a dishwasher, trash can, or washing machine.

The primary objective is to make recording chore completion **fast, intuitive, and minimally disruptive**, eliminating the need to manually navigate through an application, locate a chore, and update its completion status.

## 2. Core Intent

Create a web-based family chore management system in which each household chore can be associated with a unique NFC tag.

When a household member scans an NFC tag using a compatible iPhone, the device will recognize a standard HTTPS URL and present a system notification. Upon tapping the notification, the user will be directed to the application, where the associated chore will automatically be marked as completed.

The system will identify the authenticated household member, record the completion timestamp, update the chore's status, and maintain an accurate history of chore activity.

**The intended interaction requires only two user actions:**

1. Tap the iPhone against the NFC tag.
2. Tap the notification presented by iOS.

No additional navigation, confirmation buttons, or manual chore selection should be required under normal operating conditions.

## 3. Primary Goals

### Frictionless Chore Completion

Minimize the effort required for household members to record completed chores.

The application should handle chore identification, completion recording, and status updates automatically after the NFC URL is opened.

### Simple NFC Tag Management

Allow each chore to be associated with a physical NFC tag containing a permanent HTTPS URL.

NFC tags should be:

- Independently registered within the application.
- Associated with a specific household chore.
- Reassignable to different chores without requiring physical reprogramming.
- Reusable for recurring chores.
- Accessible to authorized household members without individual NFC automation configuration.

### Multi-User Household Support

Support multiple family members using their own devices.

The system should identify the authenticated user completing a chore and associate that completion with the appropriate household member.

The experience should not require each user to configure Apple Shortcuts or manually register NFC tags on their device.

### Recurring Chore Management

Support chores that repeat according to defined schedules, such as daily, weekly, or custom intervals.

Completing a chore should record the completion of the current occurrence without permanently closing or removing the underlying chore.

### Completion History and Accountability

Maintain a history of chore completions, including:

- Chore completed.
- Household member responsible.
- Date and time of completion.
- Completion method, including NFC.
- Associated recurring chore occurrence.

Prevent duplicate completions or duplicate rewards when the same tag is scanned multiple times for an already-completed occurrence.

## 4. Intended User Experience

**Example: Emptying the Dishwasher**

A household member finishes emptying the dishwasher.

Rather than opening the chore management application and manually marking the task complete, the user:

1. Places their iPhone near the NFC tag attached to the dishwasher.
2. Receives an NFC notification from iOS.
3. Taps the notification.
4. Is directed to the web application, which automatically records the chore completion.
5. Sees a brief confirmation indicating that the chore was successfully completed.

The application records who completed the chore and when, updates the current chore occurrence, and determines its next scheduled occurrence according to the configured recurrence rules.

**The user should not need to locate the chore, select it, or press a completion button.**

## 5. Technical Direction

The application will follow a web-first architecture, utilizing standard HTTPS URLs stored on NFC tags.

### Frontend

- TypeScript
- React
- TanStack Router
- TanStack Query

The frontend will provide household management, chore configuration, NFC tag administration, chore status visibility, and completion confirmation.

### Backend

- TypeScript
- Bun
- Hono
- PostgreSQL

The backend will manage authentication, authorization, households, users, chores, recurrence rules, NFC tag associations, and completion records.

### NFC Integration

Each NFC tag will contain a permanent HTTPS URL identifying its registered tag record.

Example:

`https://chores.example.com/nfc/{tagId}`

When the URL is opened:

1. The application resolves the NFC tag to its associated chore.
2. The user's authenticated session is validated.
3. The user's authorization to complete the chore is verified.
4. The frontend submits an authenticated completion request to the backend.
5. The backend records the completion, enforcing duplicate-completion protections.
6. The application displays the result.

The initial implementation will not require a native iOS application, Apple Shortcuts integration, or direct Core NFC access.

## 6. Security and Reliability Requirements

The application should enforce the following principles:

- NFC tag URLs identify registered tags but do not contain unrestricted authentication credentials.
- Household members must be authenticated and authorized to complete chores.
- HTTP GET requests must not directly modify chore completion records.
- Chore completion must occur through a validated backend operation.
- Duplicate scans must not produce duplicate completion records or rewards for the same chore occurrence.
- Failed requests must produce clear feedback rather than falsely indicating successful completion.
- The system should handle expired sessions by requiring authentication before recording completion.

Because NFC tags contain readable HTTPS URLs, possession of the URL alone will not be treated as proof of physical presence at the tag.

## 7. Platform Strategy

The initial application will target modern iPhones capable of background NFC tag detection.

The system will use standard HTTPS URLs rather than relying on Apple-specific NFC automation features.

This approach provides several advantages:

- No per-user or per-tag Shortcuts setup.
- No native iOS application required for the initial release.
- No Apple App Store distribution requirement for the web application.
- A single NFC tag can be used by multiple authorized household members.
- New chores and NFC tags can be introduced without requiring changes to users' devices.
- The architecture can support other NFC-capable platforms where compatible URL handling is available.

Native mobile applications may be introduced in future development phases, using Apple Universal Links or equivalent platform mechanisms to open the installed application directly.

Existing NFC tags should remain compatible with future native implementations.

## 8. Initial Scope and Future Opportunities

### Initial Scope

The initial implementation should prioritize:

- Household and family member management.
- Chore creation, editing, and assignment.
- Recurring chore scheduling.
- NFC tag registration and chore association.
- Automatic chore completion through NFC URL navigation.
- Completion history.
- Duplicate-completion protection.
- Clear confirmation and error handling.

### Potential Future Enhancements

The architecture should accommodate, without requiring their implementation in the initial release:

- Points, rewards, and gamification.
- Chore streaks and completion statistics.
- Push notifications and reminders.
- Parent approval workflows.
- Household dashboards and activity reports.
- Native iOS and Android applications.
- Alternative completion methods, such as QR codes.
- More advanced chore rotation and assignment rules.

These capabilities are potential future extensions rather than established requirements for the initial version.

## 9. Constraints and Design Decisions

The project will explicitly recognize and accommodate current iOS limitations.

The ideal interaction would be:

**Tap NFC tag → Chore automatically completed without additional interaction.**

However, achieving this through Apple Shortcuts would require individually configuring NFC automations on each household member's device for each chore tag.

That configuration burden is not acceptable for a scalable household chore management application.

Therefore, the selected initial interaction is:

**Tap NFC tag → Tap iOS notification → Chore automatically completed.**

The web application will briefly open to process the completion and present feedback. No further user input should be necessary when the user is already authenticated and authorized.

The application will prioritize minimal configuration, predictable behavior, and ease of adoption over eliminating the single notification interaction.

## 10. Definition of Success

The project will be considered successful when a household can create and assign recurring chores, associate those chores with physical NFC tags, and allow multiple family members to record completions through their iPhones without configuring individual device automations.

A household member should be able to complete a chore and record that completion through the two-action NFC interaction, while the system accurately maintains user attribution, recurrence state, and completion history.

**The guiding principle is simple:**

> Completing a chore in the real world should make recording its completion in the digital world nearly effortless.

The application should reduce administrative friction for household members while providing an accurate, accessible, and extensible system for managing household responsibilities.