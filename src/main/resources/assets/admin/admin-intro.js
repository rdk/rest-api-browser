(function () {
    'use strict';

    function init() {
        var root = document.getElementById('rab-admin-intro');
        if (!root) {
            return;
        }
        var statusEl = root.querySelector('[data-rab-copy-status]');

        function announce(button, ok) {
            if (!statusEl) {
                return;
            }
            var hint = (button.getAttribute('aria-label') || '').replace(/^Copy\s+/i, '').trim();
            var message = ok
                ? (hint ? 'Copied ' + hint + ' to clipboard.' : 'Copied to clipboard.')
                : 'Clipboard copy failed. Select and copy the text manually.';
            clearTimeout(statusEl._rabTimer);
            statusEl.textContent = '';
            statusEl._rabTimer = setTimeout(function () {
                statusEl.textContent = message;
            }, 20);
        }

        function flash(button, ok) {
            if (!button.dataset.rabLabel) {
                button.dataset.rabLabel = button.textContent || 'Copy';
            }
            clearTimeout(button._rabTimer);
            button.textContent = ok ? 'Copied' : 'Copy failed';
            button.classList.toggle('is-copied', ok);
            button.classList.toggle('is-failed', !ok);
            announce(button, ok);
            button._rabTimer = setTimeout(function () {
                button.textContent = button.dataset.rabLabel;
                button.classList.remove('is-copied', 'is-failed');
                button._rabTimer = null;
            }, 1500);
        }

        function fallbackCopy(text) {
            var prev = document.activeElement;
            var host = document.body || document.documentElement;
            var area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.setAttribute('aria-hidden', 'true');
            area.tabIndex = -1;
            area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;';
            host.appendChild(area);
            var ok = false;
            try {
                try {
                    area.focus({ preventScroll: true });
                } catch (e) {
                    area.focus();
                }
                area.select();
                if (typeof area.setSelectionRange === 'function') {
                    area.setSelectionRange(0, text.length);
                }
                ok = document.execCommand('copy');
            } catch (e) {
                ok = false;
            } finally {
                if (area.parentNode) {
                    area.parentNode.removeChild(area);
                }
                if (prev && typeof prev.focus === 'function' && prev !== area) {
                    try {
                        prev.focus({ preventScroll: true });
                    } catch (e) {
                        prev.focus();
                    }
                }
            }
            return ok;
        }

        function writeClipboard(text, done) {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).then(
                    function () { done(true); },
                    function () { done(fallbackCopy(text)); }
                );
                return;
            }
            done(fallbackCopy(text));
        }

        function resolveText(button) {
            var direct = button.getAttribute('data-copy-text');
            if (direct !== null) {
                return direct;
            }
            var targetId = button.getAttribute('data-copy-target');
            if (!targetId) {
                return '';
            }
            var target = document.getElementById(targetId);
            return target ? (target.textContent || '') : '';
        }

        root.addEventListener('click', function (event) {
            var target = event.target;
            var button = target && target.closest ? target.closest('[data-copy-text], [data-copy-target]') : null;
            if (!button || !root.contains(button)) {
                return;
            }
            var text = resolveText(button);
            if (!text) {
                flash(button, false);
                return;
            }
            writeClipboard(text, function (ok) {
                flash(button, ok);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
