import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library renders into document.body. Without explicit cleanup
// between tests the DOM accumulates trees from previous renders and assertions
// like `getByRole` start matching multiple elements.
afterEach(() => {
  cleanup();
});
