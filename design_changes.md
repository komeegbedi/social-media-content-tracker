# IFC Creatives Board — Design Changes

## Purpose

This document defines the next visual-quality refinement pass for IFC Creatives Board.

The current redesign has a strong foundation: the interface is substantially cleaner, spacing is more deliberate, typography is more consistent, Heroicons improve the visual language, and the app now feels more cohesive.

The next step is to move from a polished prototype to a world-class product experience by improving hierarchy, consistency, dark mode, mobile behaviour, control styling, and interaction design.

This refinement must preserve all existing functionality, permissions, Firestore behaviour, notifications, reminders, recurring events, and backend logic.

---

# 1. Overall Design Direction

The application should feel:

- Modern
- Clean
- Calm
- Premium
- Creative
- Mobile-first
- Accessible
- Easy to scan
- Consistent across every page
- Appropriate for a church creative team

The goal is not to add more decoration. The goal is to improve product hierarchy, visual rhythm, usability, and consistency.

Use the shared inspiration references as guidance for:

- Generous whitespace
- Softer colour systems
- Refined typography
- Cleaner cards and surfaces
- Better mobile navigation
- Better drawers and overlays
- Stronger forms
- Subtle motion
- Clear hierarchy
- Fewer competing actions

Do not copy any reference exactly. Build one cohesive IFC Creatives Board design language.

---

# 2. Simplify the Global Application Shell

The sidebar currently contains too many persistent controls:

- Search
- Main navigation
- Management navigation
- New content
- User information
- Theme control
- Notifications
- Report issue
- Sign out
- Product footer

This makes the lower half of the sidebar feel like a stack of equally important buttons.

## Recommended Sidebar Structure

Keep the sidebar focused on navigation:

```text
Home
My Day
Board
My Work

Management
Team
Admin
```

Keep **New content** as the primary sidebar action on desktop.

Move the following into the user profile menu:

- Theme
- Profile
- Settings
- Sign out

Keep Notifications as either:

- A primary destination in navigation, or
- A top-header action with a compact unread badge

Keep **Report an issue** visually quiet. It may appear as:

- A small text link near the bottom
- An option inside Help
- A compact item in the user menu

The unread count should appear as a small badge attached to the bell icon instead of loose `9+` text aligned at the far edge.

---

# 3. Remove Duplicate Primary Actions

Content creation currently appears in several places:

- Sidebar New content
- Floating plus button
- Admin New content
- Home Create content buttons
- Plan content links
- Open board links

This creates unnecessary competition.

## Recommended Action Hierarchy

### Desktop

- Keep the sidebar **New content** button as the persistent global action.
- Remove the floating Create button.
- Keep contextual **Create content** actions on event cards.
- Remove large duplicate New content actions from Admin.

### Mobile

Use only one persistent creation action:

- Either the centre item in bottom navigation, or
- One floating action button

Do not show both.

## Wording Rules

Use:

- `Create content` when opening the content form
- `View content` when content already exists
- `Open board` when navigating to the broader workflow
- `New content` as the main global creation action

Avoid having `Plan content` and `Create content` compete for the same purpose.

---

# 4. Refine Typography

Typography is improved, but some page titles are too large relative to the content beneath them.

The repeated gold uppercase eyebrow on every page can feel decorative rather than useful.

Examples include:

- CONTROL ROOM
- EVERYTHING IN MOTION
- WHAT NEEDS YOU NEXT
- WHAT'S ON YOUR PLATE

Use eyebrows only when they add meaningful context.

## Recommended Type Scale

```text
Desktop page title: 40–44px
Mobile page title: 30–34px
Section title: 20–24px
Card title: 15–17px
Body text: 15–16px
Metadata: 12–13px
```

## Typography Rules

- Use one modern sans-serif throughout the product.
- Reserve bold text for page titles, section titles, and critical values.
- Use medium weight for task names.
- Use regular weight for descriptions and supporting text.
- Avoid excessive uppercase metadata.
- Use spacing and hierarchy instead of overusing bold or colour.

Prefer:

```text
Admin
Manage people, content, events, and operational issues.
```

Instead of:

```text
CONTROL ROOM
Admin
What needs leadership attention.
```

---

# 5. Refine the Light Colour System

The light theme is clean but slightly washed out. The purple and gold pairing can feel more sophisticated.

## Suggested Light Palette

```text
Canvas:          #F7F6FA
Surface:         #FFFFFF
Surface muted:   #F0EEF6
Text primary:    #211B32
Text secondary:  #777187
Border:          #E6E2EC

Primary:         #6750C8
Primary hover:   #5941BA
Primary muted:   #EEEAFE

Gold accent:     #C88918
Success:         #258A5B
Warning:         #C88513
Danger:          #D24F52
Info:            #3974B9
```

## Colour Usage

Use purple primarily for:

- Primary actions
- Active navigation
- Selected controls
- Important links
- Progress states
- Unread indicators

Use gold primarily for:

- Selective eyebrows
- Due-soon states
- Event highlights
- Small brand moments

Do not use gold as a large full-width primary action. For example, **Auto-assign crew** should not visually compete with the main purple action.

---

# 6. Rebuild Dark Mode

Dark mode currently feels too heavy because it relies on large areas of near-black with dark purple cards layered on top.

Dark mode should feel intentionally designed rather than inverted.

## Suggested Dark Palette

```text
Canvas:           #0F0C16
Sidebar:          #14101D
Surface:          #191522
Surface elevated: #211B2D
Surface muted:    #272035
Border:           #332A42

Text primary:     #F5F2FA
Text secondary:   #A9A2B7
Text muted:       #817A90

Primary:          #9A83EE
Primary hover:    #AD9AF3
Primary muted:    #2B2345

Gold accent:      #DEA43A
Success:          #48B981
Warning:          #E0A43B
Danger:           #EC7277
```

## Dark Mode Rules

- Avoid pure black.
- Give canvas, sidebar, cards, drawers, and overlays distinct tonal levels.
- Prefer subtle borders over strong shadows.
- Use slightly muted body text.
- Use a lighter purple accent in dark mode.
- Reduce saturation in badges and status chips.
- Do not reuse light-theme colours unchanged.
- Ensure cards remain visible without looking like glowing boxes.
- Preserve readable contrast without using bright white everywhere.

Dark mode should feel calm, soft, premium, and comfortable at night.

---

# 7. Reduce Card Repetition

Nearly every element currently appears inside a rounded white card. When everything is a card, hierarchy becomes weaker.

## Keep Cards For

- Tasks
- Events
- Team members
- Approval requests
- Important summaries
- Primary grouped content

## Avoid Cards For

- Every metric
- Minor navigation rows
- Every filter
- Every secondary action
- Content that can be separated with spacing and dividers

The Home `Your focus` area may use compact list rows with:

- A subtle urgency indicator
- Thin dividers
- Minimal elevation

## Recommended Radius

```text
Controls: 8–10px
Standard cards: 12px
Large panels: 16px
Drawers and modals: 20px
```

Avoid excessive rounding.

---

# 8. Home Page Refinement

Home should answer three questions:

1. What is coming up?
2. What requires my immediate attention?
3. What has the team accomplished recently?

## Coming Up

Show:

- Event name
- Date
- Days remaining
- Planning status
- Create content or View content action

Keep the cake emoji for birthdays.

Use Heroicons outline for non-birthday events.

## Your Focus

Limit the section to the top three or four items.

Add a clear link:

```text
View all in My Day
```

## Recent Wins

Add a compact positive section such as:

```text
3 content pieces approved this week
Sunday sermon clip posted
Baptism gallery completed
```

Home should feel encouraging, not like another full task-management screen.

---

# 9. Clarify My Day and My Work

The two screens currently overlap.

## My Day

My Day should show prioritized actions:

- Overdue
- Due today
- Due soon
- Changes requested
- Awaiting review
- Items requiring immediate action

It should be concise and action-oriented.

## My Work

My Work should show all assigned work:

- Search
- Filters
- Full assigned-content history
- Workflow grouping
- Urgency grouping
- Broader context

Home should preview My Day rather than duplicate it.

---

# 10. Clarify Board Versus Workflow

The current Board view groups tasks vertically by status and displays cards in two columns.

That behaves more like a grouped workflow page than a traditional Kanban board.

## Option A — True Board

Use horizontal workflow columns:

```text
Planned
In Progress
In Review
Changes Requested
Approved
Ready to Post
Posted
```

Use horizontal scrolling on smaller desktop widths.

Stack lanes vertically on mobile.

## Option B — Keep Current Layout

Rename the page or view to:

```text
Workflow
```

Keep Board and List as display options inside the workflow page.

Calling the current layout a board may create expectations of Kanban drag-and-drop behaviour.

## List View

Add subtle desktop column labels:

```text
Content          Status          Owner          Due
```

On mobile, use stacked list rows without column headers.

---

# 11. Improve Task Card Information Density

Create a predictable task-card anatomy.

```text
Task title                         Content type
Status · Due date
Next action
Blocker, when applicable
Assignees
```

## Task Card Rules

- Content-type badges should be quieter than workflow status.
- Avoid excessive empty space.
- Use `Supporting Jordan` only when useful.
- Avoid repeating all-caps labels such as `UP NEXT` on every card.
- Make blockers visually clear but not overwhelming.
- Keep status and due-date information easy to scan.

---

# 12. Redesign Admin Overview Actions

The Admin Overview currently uses several large full-width actions:

- New content
- Import CSV
- Create event
- Auto-assign crew

These actions take too much space and compete equally.

## Recommended Action Bar

Use one compact responsive toolbar:

```text
[+ New content] [Create event] [Import] [Auto-assign]
```

Hierarchy:

- New content: primary
- Create event: secondary
- Import: secondary
- Auto-assign: tertiary or contextual

On mobile, use:

- A two-column action grid, or
- A primary action plus More menu

## Admin Metrics

The six status metrics should use:

- Icon
- Count
- Label
- Optional supporting context

Do not rely only on coloured left borders.

---

# 13. Improve Team Load Semantics

The Team Load page is visually clean, but percentages need clearer meaning.

For example:

```text
Jordan Lee — 9 · 23%
```

It is unclear what the percentage represents.

## Better Labels

Use:

```text
9 active tasks
High workload
```

Or:

```text
9 of 12 recommended capacity
75% capacity
```

Only use percentages when there is a meaningful denominator.

## Team Load Rules

- Sort by workload by default.
- Add sorting options such as:
  - Most loaded
  - Name
  - Department
- Add accessible tooltips for segmented workload bars.
- Make the legend easier to associate with the bar segments.
- Use text labels in addition to colour where possible.

---

# 14. Refine the Notification Drawer

The right-side drawer is the correct pattern, but it needs another refinement pass.

## Drawer Size

Use approximately:

```text
420–460px on desktop
100% width on mobile
```

## Header

Use a clearer hierarchy:

```text
Notifications
19 unread
```

Keep actions in a separate aligned group:

- Mark all as read
- Settings
- Close

`Mark all as read` should be a subtle text action with an icon, not a pill competing with Settings and Close.

## Filters

Use a sticky filter row beneath the header.

Requirements:

- 8px gaps
- 32–36px height
- Horizontal scroll on narrow widths
- Hidden scrollbar
- Edge fade showing more filters exist
- No clipped or partially visible labels

Consider showing five primary filters:

```text
All
Unread
Assignments
Reviews
Reminders
```

Move less common categories into a More menu.

## Notification Rows

Each row should include:

- Type icon
- Title
- Description
- Category
- Relative time
- Unread state

Improve hierarchy between:

- Title
- Description
- Category
- Timestamp

Use row heights around 76–84px.

Align the unread dot with the title row rather than centring it vertically.

Reduce the visual strength of the icon container so the message remains dominant.

Use simple relative timestamps such as:

```text
3h ago
Yesterday
```

## Notification States

Design:

- Loading
- Empty
- Filter empty
- Error
- Offline
- All caught up

Example:

```text
You're all caught up
New assignments, reviews, reminders, and approvals will appear here.
```

---

# 15. Standardize Remaining Controls

Several controls still look native or prototype-like:

- CSV file picker
- Some dropdowns
- Some filters
- Mark all read
- Certain bordered buttons

These break the visual system.

## Standardize

- File upload
- Segmented controls
- Tabs
- Search
- Select
- Filter button
- Icon button
- Empty state
- Confirmation dialog

## CSV Upload

Replace the native browser file input with a designed drop zone:

```text
Upload CSV
Drag and drop a file here, or browse
CSV · Maximum 10 MB
```

---

# 16. Reduce Beta Banner Dominance

The Beta banner occupies premium vertical space on every page.

Recommended options:

- Make it dismissible and remember dismissal
- Reduce its height
- Show it only on Home
- Show it only to beta users
- Move Report into a smaller text action
- Convert it into a compact status strip

The banner should not compete with page headings.

---

# 17. Heroicons Rules

Use Heroicons outline as the default icon style.

Use solid icons only for:

- Active states
- Confirmed success
- Selected navigation
- Unread or high-emphasis states

## Preserve

Keep the cake emoji for birthday events.

## Replace

Use Heroicons outline for:

- Navigation
- Settings
- Notifications
- Event types
- Task types
- Admin actions
- Sign out
- Theme controls
- Search
- Filters

Ensure icon and label alignment is consistent.

The Sign out icon must align correctly with the text and use the same spacing as other utility items.

---

# 18. Motion System

Use motion to communicate structure, not decoration.

## Suggested Timings

```text
Notification drawer: 240ms
Sidebar active indicator: 160ms
Card hover: 120ms
Theme transition: 180ms
Accordion expansion: 180–220ms
Filter selection: 140ms
Modal or sheet: 240–280ms
```

## Motion Rules

Animate:

- Drawer open and close
- Modal and sheet transitions
- Active navigation changes
- Filter changes
- Mark-as-read states
- Task-status changes
- Reminder expansion
- Theme switching
- Loading-to-content transitions

Avoid:

- Animating every card on page load
- Excessive bouncing
- Long route animations
- Constant decorative motion
- Large animated blur effects

Use Motion for React for standard UI transitions.

Use GSAP only when a complex sequenced interaction genuinely requires it.

Respect `prefers-reduced-motion`.

---

# 19. Mobile-First Requirements

A redesign is not complete until the mobile experience is reviewed.

Test at:

```text
320px
375px
390px
430px
768px
```

Review:

- Bottom navigation
- Notification full-screen page
- Content-creation flow
- Reminder editor
- Admin tabs
- Board or workflow lanes
- Task cards
- Safe-area spacing
- Keyboard overlap
- Long names
- Long titles
- Drawers
- Sheets
- Filters
- Date and time controls

## Mobile Rules

- Use one persistent Create action.
- Avoid desktop tables.
- Use full-screen pages or sheets for complex flows.
- Keep touch targets at least 44px.
- Prevent horizontal page overflow.
- Respect safe-area insets.
- Ensure filters scroll smoothly.
- Keep primary actions reachable.

---

# 20. Accessibility

Maintain practical WCAG 2.1 AA standards.

Requirements:

- Visible keyboard focus
- Minimum 44px touch targets
- Semantic HTML
- Accessible labels
- Screen-reader status for unread notifications
- Text labels in addition to colour
- Proper modal focus management
- Focus return after closing overlays
- Escape-key support
- Accessible form validation
- Reduced-motion support
- Sufficient contrast
- Usability at 200% browser zoom

Run:

- Keyboard-only testing
- Chrome Lighthouse accessibility audit
- axe DevTools
- VoiceOver testing on macOS or iPhone

---

# 21. Performance

The redesign should not significantly worsen performance.

Requirements:

- Import Heroicons individually
- Lazy-load large admin areas
- Code-split role-specific screens
- Paginate long notification lists
- Avoid expensive rerenders
- Avoid loading full histories
- Optimize fonts
- Prefer opacity and transform animations
- Avoid animating large blurred surfaces
- Review bundle-size changes

The Admin area is a good candidate for route-level code splitting.

---

# 22. Recommended Improvement Order

Complete the next refinement pass in this order:

1. Rebuild dark-mode tokens and surface hierarchy.
2. Remove duplicate creation actions.
3. Simplify sidebar utilities.
4. Fix Notification Center header and filters.
5. Redesign Admin Overview actions.
6. Clarify Board versus Workflow.
7. Standardize native controls.
8. Refine typography and reduce unnecessary eyebrows.
9. Reduce card repetition and heavy shadows.
10. Complete mobile visual QA.
11. Complete accessibility testing.
12. Review performance and bundle size.

---

# 23. Implementation Brief for the AI

Perform a visual-quality refinement pass across IFC Creatives Board without changing existing functionality.

Focus on product hierarchy rather than adding more decoration.

Simplify duplicate actions, reduce persistent chrome, improve typography, create distinct light and dark surface systems, standardize all controls, and make every screen feel like part of one coherent product.

Use Heroicons outline as the default icon style. Solid icons may only be used for selected or confirmed states. Keep the cake emoji exclusively for birthday events.

Rebuild dark mode using layered warm-purple neutral surfaces rather than pure black. Establish separate canvas, sidebar, surface, elevated-surface, border, primary-text, and secondary-text tokens. Reduce badge saturation and avoid copying light-theme colours directly into dark mode.

Remove the desktop floating Create button because New content already exists in the sidebar. Keep contextual Create content actions on event cards. On mobile, expose only one persistent creation action.

Simplify the sidebar by moving Theme and Sign out into the user-profile menu. Present Notifications as a primary destination or header action with a compact unread badge. Keep Report an issue visually quiet.

Refine the Notification Center into a 420–460px desktop drawer and a full-screen mobile page. Rework the header spacing, make Mark all as read a subtle text action, align the settings and close icon buttons, make the filters a consistent scrollable row, and prevent clipped labels. Group notification rows clearly and align unread dots with the title row.

Replace the Admin Overview's large full-width action bars with a compact responsive action toolbar. Use New content as the single primary action, while Create event, Import, and Auto-assign remain secondary or tertiary.

Review whether the current Board view is a true Kanban board. Either implement workflow columns or rename the grouped view to Workflow. Add clear column meaning to list view.

Reduce overuse of cards, borders, rounded containers, uppercase labels, and shadows. Use spacing and typography to create hierarchy. Not every item should be a card.

Standardize the remaining native controls, especially CSV upload, selects, filters, tabs, and action buttons. Do not leave browser-default controls inside an otherwise custom design system.

Complete a mobile-first review at 320px, 375px, 390px, 430px, and 768px. Do not call the refinement complete until notification, reminder, content-creation, board, admin, and team workflows are visually verified at those widths.

Preserve all workflows, role permissions, Firestore behaviour, notification logic, reminders, recurring events, and backend functionality. This is a refinement pass, not a rewrite.

---

# 24. Completion Criteria

The refinement is complete when:

- Dark mode has a proper layered surface system
- Duplicate Create actions have been removed
- Sidebar utility controls are simplified
- Heroicons outline is used consistently
- Birthday events retain the cake emoji
- Notification filters are aligned and no longer clipped
- Notification header actions are properly spaced
- Sign out icon and label alignment are corrected
- Admin actions have a clear hierarchy
- Board and Workflow terminology is resolved
- Native controls are replaced with designed components
- Light and dark themes feel equally polished
- Mobile workflows have been visually verified
- Accessibility checks pass
- Existing functionality is preserved
- No backend behaviour has been unintentionally changed
- Performance and bundle-size changes are documented

---

## Cross-browser animation audit & compatibility (v1.1.2 addendum)

Motion must be tested beyond Chrome. Some animations were not appearing
consistently in Safari (iPhone and installed PWA). Do not assume an animation
works everywhere just because it works in Chrome.

**Environments:** Chrome / Safari / Firefox / Edge desktop; iPhone Safari;
iPhone installed PWA; Android Chrome. Also verify light+dark, portrait+landscape,
and reduced-motion on/off.

**Motion implementation rules**
- Animate `transform` and `opacity` only.
- Avoid `height:auto` transitions, large filter/backdrop-filter animations, and
  animating `top`/`left`. Accordions fade+rise revealed content (`revealIn`)
  rather than animating height.
- Prefer `translate3d(...)` where it improves Safari compositing. Do not overuse
  `will-change`; keep it on genuinely animated elements only (the nav indicator).

**Safari-specific fallbacks (required)**
- Every `backdrop-filter` ships with `-webkit-backdrop-filter` and an
  `@supports not (...)` opaque fallback.
- Every `color-mix()` glass surface ships a **solid `background` fallback first**
  (iOS < 16.2 drops the whole declaration otherwise → transparent/invisible
  surface). Applies to the bottom nav, its active indicator, the mobile header,
  and unread notification rows.
- `100dvh` always paired with a `100vh` fallback; safe-area insets on all fixed
  edges.
- Do not place `position:fixed` overlays inside transformed ancestors (Safari
  mis-anchors them). The floating nav and FAB sit at the shell level, outside the
  transformed `.sb-page`.

**Reduced motion:** a single global `prefers-reduced-motion` reset disables all
transitions/animations; the nav indicator updates instantly. Verify the device's
accessibility setting before diagnosing "missing" animation.

The goal is not identical rendering everywhere — it is that every supported
browser preserves the same interaction meaning and polish with no missing or
broken motion.
