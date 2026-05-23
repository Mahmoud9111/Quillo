import mongoose, { model, Schema } from "mongoose";
import { IVoiceSession } from "@/types";

const VoiceSessionSchema = new Schema<IVoiceSession>({
    clerkId: { type: String, required: true, index: true },
    bookId: { type: Schema.Types.ObjectId, ref: 'Book', required: true },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0, required: true },
}, { timestamps: true });

// Force-recompile in dev so schema edits (HMR) take effect without a server restart.
if (process.env.NODE_ENV !== 'production' && mongoose.models.VoiceSession) {
    delete mongoose.models.VoiceSession;
}

const VoiceSession = mongoose.models.VoiceSession || model<IVoiceSession>('VoiceSession', VoiceSessionSchema);

export default VoiceSession;
