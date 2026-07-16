import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

export class ModuleErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Puls module failed to load", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="module-loading" role="alert">
          <CircleAlert size={22} />
          <strong>Nie udało się otworzyć modułu</strong>
          <span>Po aktualizacji PWA może potrzebować odświeżenia plików.</span>
          <button
            className="button button--soft"
            type="button"
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={16} /> Odśwież aplikację
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
