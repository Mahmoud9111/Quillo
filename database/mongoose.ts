import mongoose from 'mongoose';

declare global {
    var mongooseCache: {
        conn: typeof mongoose | null
        promise: Promise<typeof mongoose> | null
    }
}

const cached = global.mongooseCache || (global.mongooseCache = { conn: null, promise: null });

export const connectToDatabase = async () => {
    if (cached.conn) return cached.conn;

    const MONGODB_URI = process.env.MONGODB_URI;
    if (!MONGODB_URI) throw new Error('Please define the MONGODB_URI environment variable');

    if (!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, {
            bufferCommands: false,
            // Serverless: small pool so a single warm lambda doesn't hog Atlas connections,
            // but >1 so concurrent server actions on the same instance don't serialize.
            maxPoolSize: 5,
            minPoolSize: 0,
            // Fail fast on cold starts instead of hanging the request for 30s default.
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 20000,
            // Cuts wire payload to/from Atlas. zlib ships with Node, no extra dep needed.
            compressors: ['zlib'],
        });
    }

    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        console.error('MongoDB connection error. Please make sure MongoDB is running. ' + e);
        throw e;
    }

    console.info('Connected to MongoDB');
    return cached.conn;
}
