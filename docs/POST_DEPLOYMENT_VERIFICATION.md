# Post-Deployment Verification & Monitoring

## Immediate Checks (First 30 minutes)

### Backend Health
```bash
# SSH to production server
ssh zarewa@prod-server

# Check all workers are running
sudo systemctl status 'zarewa@*'

# View recent logs for crashes
sudo journalctl -u 'zarewa@1' -n 50

# Health endpoint
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3002/api/health  
curl http://127.0.0.1:3003/api/health
curl http://127.0.0.1:3004/api/health
```

**Expected Output:**
```json
{"ok":true,"bootId":"...","openConnections":X}
```

### Frontend Load Test
1. Open browser (Chrome/Firefox DevTools open)
2. Navigate to `https://zarewa.example.com`
3. DevTools → Network tab, filter for `health` API call
4. Check:
   - [ ] Page loads within 30 seconds
   - [ ] API response time < 2 seconds
   - [ ] Service worker listed in Application tab (green "activated and running")

### Service Worker Verification
DevTools → Application → Service Workers
- [ ] `sw.js` shows "activated and running"
- [ ] Cached assets appear under "Cache Storage"
- [ ] No errors in console about service worker

**If service worker is missing:**
```javascript
// In browser console:
navigator.serviceWorker.getRegistrations().then(regs => {
  regs.forEach(reg => reg.unregister());
});
// Then reload page
```

---

## 24-Hour Monitoring

### Log Analysis
```bash
# Real-time worker logs (leave running in terminal)
sudo journalctl -u 'zarewa@1' -f

# Look for:
grep "migration lock" /var/log/syslog  # Should see "waiting for migration" if DB migrating
grep -i error /var/log/syslog  # Should be minimal
grep -i timeout /var/log/syslog  # Should be 0
```

### Performance Metrics

**Network Performance (Network Tab in DevTools)**
| Endpoint | Expected | Problem Indicator |
|----------|----------|-------------------|
| `/api/health` | < 500 ms | > 5 sec = worker overload |
| `/api/quotations?limit=100` | < 2 MB payload | > 3 MB = payload not optimized |
| `/api/customer-refunds` | < 1 MB payload | > 1.5 MB = preview_snapshot not excluded |
| Assets (JS/CSS) | Cached on reload | Uncached = service worker not working |

**Database Performance**
```bash
# Check for slow queries
SELECT * FROM slow_query_log ORDER BY timestamp DESC LIMIT 10;

# Connection pool status
SHOW PROCESSLIST;  # Should show 3-4 connections per worker
```

### User Experience Checks (Kaduna/Yola Network Simulation)

**Using Chrome DevTools Throttling:**
1. DevTools → Network tab → Throttling dropdown
2. Select "Slow 3G" (simulates ~100 kbps)
3. Reload page
4. Time to interactive: Should be < 45 seconds

**On-Site Tests (Actual Slow Network):**
- [ ] Dashboard loads without timeout
- [ ] Can create and save quotation
- [ ] Refund list doesn't timeout
- [ ] Charts lazy-load (no initial bloat)
- [ ] Operations don't fail on slow refresh

### Reconnect Backoff (the Kaduna outage fix)

The failure this fixes: on a link too slow to finish a bootstrap inside one retry tick,
the old fixed 12s interval started another one anyway. Attempts stacked, competed for
the same pipe, and the connection never drained enough to recover — so the worse the
network got, the harder the app hit it.

**How to confirm the fix is live.** On a desk with a genuinely bad link (or DevTools
throttled to Slow 3G, then take the network offline to force `degraded`):

1. DevTools → Network tab, filter for `bootstrap`
2. Watch the spacing between `/api/bootstrap` requests

- ✅ **Fixed:** gaps widen — roughly 12s, 24s, 48s, 96s, then steady at 120s, with only
  ever **one** request in flight at a time.
- ❌ **Not fixed:** a steady drumbeat every 12s, and/or several bootstraps in flight
  at once. If you see this, the frontend build did not pick up the change — confirm
  `dist/` was rebuilt and copied, then hard-reload (Ctrl+Shift+R) to clear the old
  service-worker-cached bundle.

Attempts after the first also send `If-None-Match`, so once the link recovers a `304`
ends the loop for a few hundred bytes rather than a full bootstrap. A `304` on a
reconnect in the Network tab is the healthy exit.

---

## Critical Issues & Resolution

### Issue: "Could not acquire migration lock" error
**Symptoms:**
- Logs show: `Could not acquire migration lock within 1200s`
- Some workers fail to start
- Previous worker may still be migrating

**Resolution:**
```bash
# 1. Check current migration process
ps aux | grep npm
ps aux | grep node

# 2. If stuck, check database lock
mysql> SELECT GET_LOCK('zarewa_run_migrations', 0);
# Result: 1 = free, 0 = locked, NULL = error

# 3. If locked, wait or manually release
mysql> SELECT RELEASE_LOCK('zarewa_run_migrations');

# 4. Restart migration
ZAREWA_MYSQL_SYNC_TIMEOUT_MS=900000 npm run db:migrate

# 5. Start workers only after migration succeeds
sudo systemctl start zarewa@1 zarewa@2 zarewa@3 zarewa@4
```

### Issue: Service Worker not caching assets
**Symptoms:**
- DevTools shows "registered but not activated"
- Assets load slowly every time
- No cache entries in Application tab

**Resolution:**
```javascript
// Browser console
navigator.serviceWorker.getRegistrations().then(regs => {
  console.log('Unregistering old service workers...');
  regs.forEach(reg => reg.unregister());
});
// Wait 5 seconds, then reload
```

Or force update:
```bash
# Clear browser cache (Cmd+Shift+Delete / Ctrl+Shift+Delete)
# Then visit site in private/incognito window
```

### Issue: Slow polling/refreshes still downloading large payloads
**Symptoms:**
- Network tab shows > 500 KB per refresh
- Performance didn't improve post-deployment

**Resolution:**
1. Verify frontend was updated: Check `dist/index.html` timestamp (should be recent)
2. Verify build included changes: Check `Sales.jsx` has `refreshDomain?.('sales')` calls
3. Hard refresh frontend: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows/Linux)
4. Check frontend is actually deployed: `curl https://zarewa.example.com/index.html | grep "Sales"`

### Issue: High CPU/Memory on workers
**Symptoms:**
- `top` command shows 90%+ CPU
- Page loads extremely slow
- Log shows frequent database retries

**Resolution:**
```bash
# 1. Check active connections
mysql> SHOW PROCESSLIST;

# 2. Identify long-running queries
mysql> SELECT * FROM INFORMATION_SCHEMA.PROCESSLIST 
       WHERE TIME > 30 ORDER BY TIME DESC;

# 3. Consider increasing worker count
sudo systemctl start zarewa@5  # Add temporary worker
```

---

## Success Criteria Checklist

**Day 1 (Deployment Day)**
- [ ] All 4 workers started successfully
- [ ] Health check endpoints respond with `"ok": true`
- [ ] No critical errors in logs (grep -i "error\|fatal" = 0 results)
- [ ] Staff can log in
- [ ] Dashboard loads

**Day 2-3 (Monitoring Period)**
- [ ] Zero worker crashes (check `sudo systemctl status zarewa@*`)
- [ ] API response time stable (< 2s median)
- [ ] Service worker activated in > 95% of sessions
- [ ] No timeout errors on quotation save
- [ ] No "transaction not recorded" reports

**Week 1 (Slow Network Validation)**
- [ ] Dashboard loads on 100 kbps network (< 45s)
- [ ] Quotation operations complete on slow network
- [ ] No staff complaints about site speed
- [ ] Refund list loads without payload bloat
- [ ] Charts lazy-load correctly (no initial page bloat)

---

## Ongoing Monitoring (Weekly)

**Metrics to Track**
```bash
# Database query performance
SELECT COUNT(*) as query_count, 
       AVG(UNIX_TIMESTAMP(timestamp)) as avg_time
FROM slow_query_log 
WHERE timestamp > DATE_SUB(NOW(), INTERVAL 1 WEEK);

# Worker uptime
sudo systemctl status zarewa@1 zarewa@2 zarewa@3 zarewa@4

# Disk usage
df -h /var/lib/zarewa

# Service worker statistics (from client analytics if available)
# - % of sessions with active service worker
# - % of assets served from cache
```

---

## Rollback Decision Tree

**If >= 2 of these are true after 1 hour, consider rollback:**
- Worker crash rate > 0 per hour
- API error rate > 1% of requests  
- Dashboard load time > 60 seconds
- Staff unable to save quotations
- Database migration failed

**Rollback command:**

Find the commit that was live before this deploy — do not trust a hash written in this
file, it will be stale. `git reflog` shows what this checkout actually had:

```bash
cd /opt/zarewa/app
git reflog -n 10        # the entry before today's pull is the rollback target
```

Then, with that hash:

```bash
sudo systemctl stop 'zarewa@*'
cd /opt/zarewa/app
git checkout <PREVIOUS_HASH>
npm ci && npm run build
ZAREWA_MYSQL_SYNC_TIMEOUT_MS=900000 npm run db:migrate
sudo systemctl start zarewa@1 zarewa@2 zarewa@3 zarewa@4
```

**Migrations do not roll back.** If the deploy applied a schema change, checking out the
old code leaves the new schema in place. Confirm the old code tolerates it before
rolling back, or restore from the pre-deploy backup instead.
