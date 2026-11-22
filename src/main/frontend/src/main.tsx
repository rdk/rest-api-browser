import { render } from 'preact';

function App() {
  return <h1>REST API Browser</h1>;
}

const root = document.getElementById('rab-next');
if (root) render(<App />, root);
