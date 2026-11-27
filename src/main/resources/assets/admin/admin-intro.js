(function () {
    'use strict';

    function fallbackCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-9999px';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        try {
            return document.execCommand('copy');
        } catch (e) {
            return false;
        } finally {
            document.body.removeChild(area);
        }
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

    function announce(message) {
        var status = document.querySelector('[data-rab-copy-status]');
        if (status) {
            status.textContent = message;
        }
    }

    function flash(button, ok) {
        if (!button.dataset.rabLabel) {
            button.dataset.rabLabel = button.textContent || 'Copy';
        }
        if (button._rabTimer) {
            clearTimeout(button._rabTimer);
        }
        button.textContent = ok ? 'Copied' : 'Copy failed';
        button.classList.toggle('is-copied', ok);
        announce(ok ? 'Copied to clipboard.' : 'Clipboard copy failed.');
        button._rabTimer = setTimeout(function () {
            button.textContent = button.dataset.rabLabel;
            button.classList.remove('is-copied');
            button._rabTimer = null;
        }, 1800);
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

    function bind() {
        var root = document.getElementById('rab-admin-intro');
        if (!root) {
            return;
        }
        var buttons = root.querySelectorAll('[data-copy-text], [data-copy-target]');
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            if (btn.dataset.rabBound === '1') {
                continue;
            }
            btn.dataset.rabBound = '1';
            btn.addEventListener('click', function (event) {
                var button = event.currentTarget;
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
