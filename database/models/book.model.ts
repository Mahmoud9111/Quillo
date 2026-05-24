import { model, Schema, models } from "mongoose";
import {IBook} from "@/types";

const BookSchema = new Schema<IBook>({
    clerkId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    author: { type: String, required: true },
    persona: { type: String },
    fileURL: { type: String, required: true },
    fileBlobKey: { type: String, required: true },
    coverURL: { type: String },
    coverBlobKey: { type: String },
    fileSize: { type: Number, required: true },
    totalSegments: { type: Number, default: 0 },
}, { timestamps: true });

// Serves Book.find({ clerkId }).sort({ createdAt: -1 }) on the library page.
BookSchema.index({ clerkId: 1, createdAt: -1 });

const Book = models.Book || model<IBook>('Book', BookSchema);

export default Book;
