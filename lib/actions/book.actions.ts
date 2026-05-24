'use server';

import {CreateBook, TextSegment} from "@/types";
import {connectToDatabase} from "@/database/mongoose";
import {escapeRegex, generateSlug, serializeData} from "@/lib/utils";
import Book from "@/database/models/book.model";
import BookSegment from "@/database/models/book-segment.model";
import mongoose from "mongoose";
import { auth } from "@clerk/nextjs/server";

// Server actions returned to client components get serialized — raw Error
// instances survive in a shape that crashes React when rendered (#31).
const toErrorMessage = (e: unknown): string =>
    e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error';

export const getAllBooks = async (search?: string) => {
    try {
        // Check auth before hitting Mongo — saves the connect cost on unauth'd hits.
        const { userId } = await auth();
        if (!userId) {
            return { success: false, error: "Unauthorized", data: [] };
        }

        await connectToDatabase();

        const query: Record<string, unknown> = { clerkId: userId };

        if (search) {
            const escapedSearch = escapeRegex(search);
            const regex = new RegExp(escapedSearch, 'i');
            query.$or = [
                { title: { $regex: regex } },
                { author: { $regex: regex } },
            ];
        }

        // Project only the fields BookCard renders — fileURL/blob keys are large strings.
        const books = await Book.find(query)
            .select('_id title author coverURL slug createdAt')
            .sort({ createdAt: -1 })
            .lean();

        return {
            success: true,
            data: serializeData(books)
        }
    } catch (e) {
        console.error('Error connecting to database', e);
        return {
            success: false, error: toErrorMessage(e), data: []
        }
    }
}

export const checkBookExists = async (title: string) => {
    try {
        await connectToDatabase();

        const slug = generateSlug(title);

        const existingBook = await Book.findOne({slug}).lean();

        if(existingBook) {
            return {
                exists: true,
                book: serializeData(existingBook)
            }
        }

        return {
            exists: false,
        }
    } catch (e) {
        console.error('Error checking book exists', e);
        return {
            exists: false, error: toErrorMessage(e)
        }
    }
}

export const createBook = async (data: CreateBook) => {
    try {
        await connectToDatabase();

        const slug = generateSlug(data.title);

        const existingBook = await Book.findOne({slug}).lean();

        if(existingBook) {
            return {
                success: true,
                data: serializeData(existingBook),
                alreadyExists: true,
            }
        }

        const { userId } = await auth();

        if (!userId || userId !== data.clerkId) {
            return { success: false, error: "Unauthorized" };
        }

        const book = await Book.create({...data, clerkId: userId, slug, totalSegments: 0});

        return {
            success: true,
            data: serializeData(book),
        }
    } catch (e) {
        console.error('Error creating a book', e);

        return {
            success: false,
            error: toErrorMessage(e),
        }
    }
}

export const getBookBySlug = async (slug: string) => {
    try {
        const { userId } = await auth();
        if (!userId) {
            return { success: false, error: "Unauthorized" };
        }

        await connectToDatabase();

        const book = await Book.findOne({ slug, clerkId: userId }).lean();

        if (!book) {
            return { success: false, error: 'Book not found' };
        }

        return {
            success: true,
            data: serializeData(book)
        }
    } catch (e) {
        console.error('Error fetching book by slug', e);
        return {
            success: false, error: toErrorMessage(e)
        }
    }
}

export const saveBookSegments = async (bookId: string, clerkId: string, segments: TextSegment[]) => {
    try {
        await connectToDatabase();

        console.log('Saving book segments...');

        const segmentsToInsert = segments.map(({ text, segmentIndex, pageNumber, wordCount }) => ({
            clerkId, bookId, content: text, segmentIndex, pageNumber, wordCount
        }));

        await BookSegment.insertMany(segmentsToInsert);

        await Book.findByIdAndUpdate(bookId, { totalSegments: segments.length });

        console.log('Book segments saved successfully.');

        return {
            success: true,
            data: { segmentsCreated: segments.length}
        }
    } catch (e) {
        console.error('Error saving book segments', e);

        return {
            success: false,
            error: toErrorMessage(e),
        }
    }
}

// Searches book segments using MongoDB text search with regex fallback.
// NOTE: This is exported from a 'use server' module, so it's reachable as a
// Next.js Server Action from any browser. The Vapi webhook is the legitimate
// caller — when invoked from elsewhere there's no user context to authorize
// against, so we rely on the unguessable bookId (Mongo ObjectId). If you ever
// need to call this from the client, add a Clerk auth check here.
export const searchBookSegments = async (bookId: string, query: string, limit: number = 5) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(bookId)) {
            return { success: false, error: 'Invalid bookId', data: [] };
        }

        await connectToDatabase();

        console.log(`Searching for: "${query}" in book ${bookId}`);

        const bookObjectId = new mongoose.Types.ObjectId(bookId);

        // Try MongoDB text search first (requires text index)
        let segments: Record<string, unknown>[] = [];
        try {
            segments = await BookSegment.find({
                bookId: bookObjectId,
                $text: { $search: query },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ score: { $meta: 'textScore' } })
                .limit(limit)
                .lean();
        } catch {
            // Text index may not exist — fall through to regex fallback
            segments = [];
        }

        // Fallback: regex search matching ANY keyword
        if (segments.length === 0) {
            const keywords = query.split(/\s+/).filter((k) => k.length > 2);
            const pattern = keywords.map(escapeRegex).join('|');

            segments = await BookSegment.find({
                bookId: bookObjectId,
                content: { $regex: pattern, $options: 'i' },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ segmentIndex: 1 })
                .limit(limit)
                .lean();
        }

        console.log(`Search complete. Found ${segments.length} results`);

        return {
            success: true,
            data: serializeData(segments),
        };
    } catch (error) {
        console.error('Error searching segments:', error);
        return {
            success: false,
            error: (error as Error).message,
            data: [],
        };
    }
};
