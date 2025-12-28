import {Html, Head, Main, NextScript} from 'next/document'
import { llmInstructions } from '@gremllm/nextjs/metadata';

export default function Document() {
    return (
        <Html lang="en">
            <Head>
                <meta name="llm-instructions" content={llmInstructions} />
            </Head>
            <body>
            <Main/>
            <NextScript/>
            </body>
        </Html>
    )
}