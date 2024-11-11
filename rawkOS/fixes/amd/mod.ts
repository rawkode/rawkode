// https://bugzilla.redhat.com/show_bug.cgi?id=2274331
export default () => {
	Deno.writeFileSync(
		"/etc/udev/rules.d/30-amdgpu-pm.rules",
		Deno.readFileSync(`${import.meta.dirname}/udev.rules`),
	);
};
