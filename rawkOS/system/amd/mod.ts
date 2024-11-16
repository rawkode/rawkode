import { $ } from "zx";

// https://bugzilla.redhat.com/show_bug.cgi?id=2274331
$`sudo cp ${import.meta.dirname}/udev.rules /etc/udev/rules.d/30-amdgpu-pm.rules`;
