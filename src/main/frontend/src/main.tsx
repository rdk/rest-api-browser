import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import './ui/skins.css';
import './ui/lozenges.css';

// the product puts web-resource scripts into the head, before the page's root element exists
function mount() {
  const root = document.getElementById('rab-next');
  if (root) {
    render(
      <App
        baseUrl={root.dataset.baseUrl ?? ''}
        classicUrl={root.dataset.classicUrl ?? ''}
        product={root.dataset.product ?? ''}
        version={root.dataset.version ?? ''}
        siteUrl={root.dataset.siteUrl ?? ''}
      />,
      root,
    );
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
