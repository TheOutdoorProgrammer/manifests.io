import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { defaultItemVersion } from "@/lib/oaspec";

export function middleware(request: NextRequest) {
    const url = request.nextUrl.clone()
    const _default = defaultItemVersion();
    if (url.pathname === '/') {
        url.pathname = `/${_default.item}/${_default.version}`
        return NextResponse.redirect(url)
    }

    return NextResponse.next();
}
