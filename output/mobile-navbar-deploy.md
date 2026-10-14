The mobile toolbar changes are now pushed to zxcvresque/VN-Reader main: ba1962f implements the navbar restore hint and mobile width hiding, and 828e096 adds the standalone loading preview. GitHub main has been verified at 828e09634a64254cc404ad21b87c3f84f9684bd9. The build and full test suite passed in a clean checkout of that repository.

Use Git directly on the VPS:

```bash
cd ~/vn-reader
git pull --ff-only
dc() {
  docker compose --env-file .env.production \
    -f compose.yaml -f deploy/compose.tunnel.yaml "$@"
}
dc build web && dc up -d --no-deps web
dc ps web
```

The standalone preview is also available in the repository at examples/loading-splash.html. The manual archive transfer below is an optional fallback; it is no longer needed for this update.

The archive mobile-navbar-update.tar.gz contains the six updated frontend source files, with their repository paths. It contains no runtime configuration, credentials, databases or media.

On your Mac, replace VPS_IP with the same server address you use for SSH:

```bash
scp "/Users/vr/Code-space/VN Reader/output/mobile-navbar-update.tar.gz" ubuntu@VPS_IP:~/mobile-navbar-update.tar.gz
```

On the VPS:

```bash
cd ~/vn-reader

# Keep a copy of the frontend files before replacing them.
tar -czf "../mobile-navbar-before-$(date +%Y%m%d-%H%M%S).tar.gz" \
  src/App.tsx src/components/TopBar.tsx \
  src/components/ReadingWidth.tsx src/components/ReaderSettings.tsx \
  src/lib/tours.ts src/styles.css

tar -xzf ~/mobile-navbar-update.tar.gz -C ~/vn-reader

dc() {
  docker compose --env-file .env.production \
    -f compose.yaml -f deploy/compose.tunnel.yaml "$@"
}

dc build web && dc up -d --no-deps web
dc ps web
dc logs --tail 30 web

# Verify that the web container includes the updated CSS and JavaScript.
dc exec -T web sh -c 'grep -l "nav-restore-button" /srv/assets/*.css /srv/assets/*.js'
```

The final command should print one CSS filename and one JavaScript filename. Refresh the browser after the build. At viewport widths below 768px, Width is hidden, and after hiding navigation the hamburger appears at the right end of Your reading with a dismissible hint.

This direct source transfer modifies the six tracked files in the VPS checkout. Commit those files to the VN-Reader repository before future Git pulls so the deployment remains reproducible.
