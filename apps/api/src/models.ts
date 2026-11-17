import { Schema, model } from 'mongoose';

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
}, { timestamps: true });

const memberSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['editor', 'viewer'], required: true },
}, { _id: false });

const fileSchema = new Schema({
  name: { type: String, required: true },
  kind: { type: String, enum: ['file', 'folder'], required: true },
  parentId: { type: Schema.Types.ObjectId, default: null },
  content: { type: String, default: '' },
  revision: { type: Number, default: 0 },
  yState: { type: Buffer, default: null },
});

const projectSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  // The creator is the single owner; members contain only editors and viewers.
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  members: { type: [memberSchema], default: [] },
  // Bounded embedded files allow atomic folder deletion without a replica-set transaction.
  files: { type: [fileSchema], default: [], select: false },
  fileTreeVersion: { type: Number, default: 0 },
  chat: { type: [{
    messageId: String,
    userId: String,
    name: String,
    text: String,
    sentAt: Date,
  }], default: [], select: false },
}, { timestamps: true });
projectSchema.index({ 'members.user': 1 });

export const User = model('User', userSchema);
export const Project = model('Project', projectSchema);
