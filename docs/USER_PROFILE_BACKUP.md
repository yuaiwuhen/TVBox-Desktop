## Background
- Professional UI designer

## Preferences
- Page design: modern and aesthetically pleasing, PC version layout (not mobile-like); prefers three-column layout for detail pages with clear information hierarchy
- Page interaction: functional and interactive
- User experience: clear loading prompts for all potentially stuck operations (e.g., downloads, conversions, loading); when returning to the homepage from the detail page, the homepage data should be cached and the previous state (including scroll position) should be maintained; after clicking page 2, there should be a loading state first, then the scrollbar scrolls to the top; when clicking top filters, filter conditions should be selected, multiple filters can be applied simultaneously, query the interface after closing the filter popup, and selected filter conditions should remain when reopening the popup; when a playback source fails due to not being logged in, a login QR code popup should be displayed instead of just a text prompt; search should be triggered by pressing Enter instead of using a search button
- Debugging: execution steps should output information to the console for easy debugging; JSON data should be printed as expandable JSON objects instead of truncated strings
- Package management: use pnpm instead of npm
- Problem-solving documentation: after successfully solving a problem, the solution思路 should be saved to a local file to avoid re-analyzing from scratch in the future