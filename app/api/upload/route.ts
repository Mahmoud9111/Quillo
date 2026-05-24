import {NextResponse} from "next/server";
import {handleUpload, HandleUploadBody} from "@vercel/blob/client";
import {auth} from "@clerk/nextjs/server";
import {MAX_FILE_SIZE} from "@/lib/constants";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
        console.error('Upload error: BLOB_READ_WRITE_TOKEN is not configured');
        return NextResponse.json({ error: 'Blob storage is not configured' }, { status: 500 });
    }

    try {
        const body = (await request.json()) as HandleUploadBody;

        const jsonResponse = await handleUpload({
            token,
            body,
            request,
            onBeforeGenerateToken: async () => {
                const { userId } = await auth();

                if(!userId) {
                    throw new Error('Unauthorized: User not authenticated');
                }

                return {
                    allowedContentTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
                    addRandomSuffix: true,
                    maximumSizeInBytes: MAX_FILE_SIZE,
                    tokenPayload: JSON.stringify({ userId })
                }
        } ,
            onUploadCompleted: async ({ blob }) => {
                console.log('File uploaded to blob:', blob.url);
                // TODO: PostHog
            }
        });

        return NextResponse.json(jsonResponse)
    } catch (e) {
        const message = e instanceof Error ? e.message : "An unknown error occurred";
        console.error('Upload error', e);
        if (message.includes('Unauthorized')) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Surface the real reason (bad token, invalid pathname, size limit, etc.)
        // so the client toast and Vercel logs both point at the cause.
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
