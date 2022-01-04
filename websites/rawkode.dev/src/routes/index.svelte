<script>
	import { seo } from '$lib/stores';

	$seo = {
		title: 'Home',
		emoji: '🏡',
		openGraph: {
			title: 'Home',
			image: 'https://capture.rawkode.dev',
		},
	};
</script>

<svelte:head>
	<title>Home | Rawkode's Modern Life</title>
</svelte:head>

<div class="prose">
	<h1>Welcome</h1>
	<h2>Who am I?</h2>
	<p>
		My name is David McKay and I am a technologist from Glasgow, Scotland. Currently I am a Staff
		Developer Advocate at Pulumi.
	</p>

	<h2>What Do I Do?</h2>

	<h3>Public Speaking</h3>

	<p>
		If you want to see some of my presentations from the last couple of years, you can find most of
		their details on Noti.st.
	</p>

	<h3>OpenSource & Kubernetes</h3>
	<p>
		I am also an active OSS contributor and active Kubernetes Organisation and release team member.
	</p>

	<h3>Technologies</h3>

	<p>Here's some of the things I find most interesting at the moment ...</p>

	<ul>
		<li>Actor Model</li>
		<li>Apache Arrow</li>
		<li>Containers with Docker, Kubernetes, and Podman</li>
		<li>Crystal (Language)</li>
		<li>Elixir (Language)</li>
		<li>Event Sourcing</li>
		<li>Gleam (Language)</li>
		<li>Monitoring & Observability</li>
		<li>Pony (Language)</li>
		<li>Rust (Language)</li>
		<li>WebAssembly (Runtime)</li>
	</ul>
</div>
