import React, {Component, ErrorInfo, ReactNode} from "react";
import posthog from "posthog-js";
import ErrorBoundaryContent from "@/components/ErrorBoundaryContent";

interface Props {
    children?: ReactNode;
}

interface State {
    hasError: boolean;
}

class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false
    };

    public static getDerivedStateFromError(_: Error): State {
        return {hasError: true};
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
        posthog.captureException(error);
    }

    public render() {
        if (this.state.hasError) {
            return <ErrorBoundaryContent errorType="500"/>;
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
