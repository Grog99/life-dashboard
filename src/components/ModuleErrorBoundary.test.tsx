import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModuleErrorBoundary } from "./ModuleErrorBoundary";

function BrokenModule(): never {
  throw new Error("lazy chunk failed");
}

describe("ModuleErrorBoundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces a failed lazy module with a recoverable alert", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ModuleErrorBoundary>
        <BrokenModule />
      </ModuleErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/Nie udało się otworzyć modułu/i);
    expect(screen.getByRole("button", { name: /Odśwież aplikację/i })).toBeInTheDocument();
  });
});
