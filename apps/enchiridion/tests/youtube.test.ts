import { describe, expect, it } from "vitest";
import { parseYouTubeUrl, youtubeEmbedUrl } from "../src/lib/youtube";

describe("youtube link parsing", () => {
	it("normalizes common YouTube video URLs", () => {
		expect(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=43s")).toEqual({
			videoId: "dQw4w9WgXcQ",
			url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
			title: "YouTube video",
		});
		expect(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toMatchObject({
			videoId: "dQw4w9WgXcQ",
		});
		expect(parseYouTubeUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toMatchObject({
			videoId: "dQw4w9WgXcQ",
		});
	});

	it("supports embed URLs and protocol-less copied links", () => {
		expect(parseYouTubeUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toMatchObject({
			videoId: "dQw4w9WgXcQ",
		});
		expect(parseYouTubeUrl("www.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({
			videoId: "dQw4w9WgXcQ",
		});
		expect(parseYouTubeUrl("music.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({
			videoId: "dQw4w9WgXcQ",
		});
		expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
	});

	it("rejects non-YouTube and mixed text clipboard values", () => {
		expect(parseYouTubeUrl("Watch this https://youtu.be/dQw4w9WgXcQ")).toBeNull();
		expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
		expect(parseYouTubeUrl("https://www.youtube.com/watch?v=not-a-valid-id")).toBeNull();
	});
});
