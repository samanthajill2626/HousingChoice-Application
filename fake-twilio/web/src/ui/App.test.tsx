import { render, screen } from '@testing-library/react';
import { App } from './App.js';

test('renders the app heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /fake phones/i })).toBeVisible();
});
