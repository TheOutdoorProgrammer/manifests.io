import '@/styles/globals.css'
import type {AppProps} from 'next/app'
import { useEffect } from 'react'
import posthog from 'posthog-js'
import ErrorBoundary from "@/components/ErrorBoundary";

export default function App({Component, pageProps}: AppProps) {
    useEffect(() => {
        posthog.init('phc_aur20epnEcOsmKpTpdbPMjJSzM5ypEtSD4zLwm0Q0aD', {
            api_host: 'https://g.theoutdoorprogrammer.com',
            capture_pageview: true,
            capture_pageleave: true,
            autocapture: true,
        });
    }, []);

    return (
        <ErrorBoundary>
            <Component {...pageProps} />
        </ErrorBoundary>
    );
}
