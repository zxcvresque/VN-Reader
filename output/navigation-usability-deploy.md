# Global navigation and usability update

The local implementation is complete. The running preview uses sample data at
`http://localhost:5199/`. This update has not been deployed to the VPS.

`navigation-usability-update.tar.gz` contains the four changed frontend source
files, two regression test files and the usability/backend review. It contains
no environment files, credentials, databases, sessions or QA fixture data.

The change keeps the existing colors. It makes the mobile restore hamburger
global, separates page toolbars from scrolling content, reduces the mobile dock
to 64px, keeps 44px controls, limits Focus to Read and exits focus when leaving
that view. The original controls and destination pages remain available.

Transfer the archive using your usual SSH host/key:

```bash
scp "/Users/vr/Code-space/VN Reader/output/navigation-usability-update.tar.gz" ubuntu@VPS_IP:~/navigation-usability-update.tar.gz
```

On the VPS, preserve the source before replacing it:

```bash
cd ~/vn-reader
tar -czf "../navigation-usability-before-$(date +%Y%m%d-%H%M%S).tar.gz" \
  src/App.tsx src/components/TopBar.tsx src/styles.css src/lib/tours.ts \
  tests/topBarAutoHide.test.mjs tests/welcome.test.mjs
tar -xzf ~/navigation-usability-update.tar.gz -C ~/vn-reader
dc() {
  docker compose --env-file .env.production \
    -f compose.yaml -f deploy/compose.tunnel.yaml "$@"
}
dc build web
dc up -d --no-deps web
dc ps web
```

Verify Read, Threads, Bookmarks and Progress on a phone. Hide navigation, restore
it from the toolbar, switch pages, and scroll Progress: the toolbar and chart
should stay separate. Focus should appear only on Read; choosing another page
should exit it. Check the same views with navigation pinned.

This frontend-only archive does not include the earlier operator-log/backend
update. Apply `operator-logs-update.tar.gz` and rebuild `archive`, `accounts` and
`mirror` as described in `operator-logs-deploy.md` to deploy that separate work.
Keep source changes in the VN-Reader repository before future Git pulls.
