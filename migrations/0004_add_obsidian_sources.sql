-- Add obsidian_sources column for tracking Obsidian vault file paths that reference a memory
ALTER TABLE memories ADD COLUMN obsidian_sources TEXT;
