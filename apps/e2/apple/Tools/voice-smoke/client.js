const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const status = document.querySelector("#status");
const display = document.querySelector("#events");
const output = document.querySelector("#audio");
let peer, channel, context, source, recorder, sessionID, timer;
const events = [], chunks = [];
let closed = false, stopping = false, failure = null;
const post = async (path, body, json = true) => {
	const response = await fetch(path, {
		method: "POST",
		headers: {
			"X-Test-Token": globalThis.testToken,
			"Content-Type": json ? "application/json" : "audio/webm",
		},
		body: json ? JSON.stringify(body) : body,
	});
	const result = await response.json();
	if (!response.ok) throw new Error(result.error ?? "Request failed");
	return result;
};
const finish = async () => {
	if (stopping) return;
	stopping = true;
	stop.disabled = true;
	clearTimeout(timer);
	try {
		source?.stop();
	} catch {
		/* Keep the original test failure visible if evidence cannot be saved. */
	}
	if (!closed && channel?.readyState === "open") {
		channel.send(JSON.stringify({ type: "session.close" }));
		const deadline = Date.now() + 3000;
		while (!closed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	if (recorder?.state === "recording") {
		await new Promise((resolve) => {
			recorder.addEventListener("stop", resolve, { once: true });
			recorder.stop();
		});
	}
	peer?.close();
	await context?.close();
	const result = {
		sessionID,
		finalEventObserved: closed,
		events,
		failure,
		hangupConfirmed: false,
		recordedBytes: chunks.reduce((n, chunk) => n + chunk.size, 0),
	};
	if (sessionID) {
		try {
			await post("/end", { id: sessionID });
			result.hangupConfirmed = true;
		} catch (error) {
			result.failure ??= error.message;
		}
	}
	try {
		await post("/result", new Blob(chunks, { type: "audio/webm" }), false);
		await post("/events", result);
		status.textContent = result.failure
			? `Test failed: ${result.failure}. Evidence saved.`
			: `Saved real output and event evidence. Final session event: ${closed}. Listen to the saved recording to qualify audible output.`;
	} catch (error) {
		status.textContent = `Audio stopped; ${error.message}`;
	}
};
stop.onclick = finish;
start.onclick = async () => {
	start.disabled = true;
	stop.disabled = false;
	status.textContent = "Connecting…";
	try {
		if (!MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
			throw new Error("Use Chrome or Firefox for WebM output recording");
		}
		context = new AudioContext();
		await context.resume();
		const decoded = await context.decodeAudioData(
			await (await fetch("/input.wav")).arrayBuffer(),
		);
		const destination = context.createMediaStreamDestination();
		source = context.createBufferSource();
		source.buffer = decoded;
		source.connect(destination);
		peer = new RTCPeerConnection();
		destination.stream.getTracks().forEach((track) =>
			peer.addTrack(track, destination.stream)
		);
		peer.ontrack = (event) => {
			const stream = new MediaStream([event.track]);
			output.srcObject = stream;
			output.play().catch(() => {});
			recorder = new MediaRecorder(stream, {
				mimeType: "audio/webm;codecs=opus",
			});
			recorder.ondataavailable = (e) => {
				if (e.data.size) chunks.push(e.data);
			};
			recorder.start(1000);
		};
		channel = peer.createDataChannel("oai-events");
		channel.onmessage = ({ data }) => {
			const event = JSON.parse(data);
			events.push(event);
			display.textContent = events.filter((e) =>
				e.delta ||
				["session.started", "session.closed", "error"].includes(e.type)
			).map((e) => `${e.type}: ${e.delta ?? ""}`).join("\n");
			if (event.type === "session.started" && !stopping) {
				status.textContent = "Streaming prerecorded speech";
				source.start();
				clearTimeout(timer);
				timer = setTimeout(finish, 60_000);
			}
			if (event.type === "session.closed") {
				closed = true;
				if (!stopping) void finish();
			}
		};
		await peer.setLocalDescription(await peer.createOffer());
		const deadline = Date.now() + 10_000;
		while (peer.iceGatheringState !== "complete") {
			if (Date.now() > deadline) throw new Error("ICE gathering timed out");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const answer = await post("/session", { sdp: peer.localDescription.sdp });
		sessionID = answer.session.id;
		if (stopping) {
			await post("/end", { id: sessionID });
			return;
		}
		await peer.setRemoteDescription({
			type: "answer",
			sdp: answer.transport.sdp,
		});
		if (!timer) timer = setTimeout(finish, 60_000);
	} catch (error) {
		failure = error.message;
		status.textContent = error.message;
		await finish();
	}
};
