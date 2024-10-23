import getpass
from archinstall import GfxDriver
from archinstall import Installer
from archinstall import profile
from archinstall import disk
from archinstall import locale
from archinstall import mirrors
from archinstall import models
from archinstall import run_custom_user_commands
from archinstall.default_profiles.desktop import DesktopProfile
from archinstall.default_profiles.desktops.gnome import GnomeProfile
from archinstall.default_profiles.profile import GreeterType
from pathlib import Path

username = "rawkode"

print("Hi, f{username}! We're about to blow away your disk and install Arch Linux.")
print("Use SIGINT (Ctrl+C) to abort the installation.")

device = (input('Which disk? (Defaults to /dev/nvme0n1): ').strip() or "/dev/nvme0n1")

fs_type = disk.FilesystemType.Btrfs
device_path = Path(device)

device = disk.device_handler.get_device(device_path)

if not device:
	raise ValueError("Could not find device. Maybe try `wipefs --all f{device}` ?")

device_modification = disk.DeviceModification(device, wipe=True)

boot_partition_size = int(1024)

boot_partition = disk.PartitionModification(
	status=disk.ModificationStatus.Create,
	type=disk.PartitionType.Primary,
	start=disk.Size(0, disk.Unit.MiB, device.device_info.sector_size),
	length=disk.Size(boot_partition_size, disk.Unit.MiB, device.device_info.sector_size),
	mountpoint=Path('/boot'),
	fs_type=disk.FilesystemType.Fat32,
	flags=[disk.PartitionFlag.Boot, disk.PartitionFlag.ESP]
)

device_modification.add_partition(boot_partition)

root_start = disk.Size(boot_partition_size+1, disk.Unit.MiB, device.device_info.sector_size)
root_length = device.device_info.total_size - root_start

subvolumes = [
	disk.SubvolumeModification(Path('@root'), Path('/')),
	disk.SubvolumeModification(Path('@home'), Path('/home')),
	disk.SubvolumeModification(Path('@log'), Path('/var/log')),
	disk.SubvolumeModification(Path('@pkg'), Path('/var/cache/pacman/pkg')),
	disk.SubvolumeModification(Path('@nix'), Path('/nix')),
	disk.SubvolumeModification(Path('@.snapshots'), Path('/snapshots')),
]

root_partition = disk.PartitionModification(
	status=disk.ModificationStatus.Create,
	type=disk.PartitionType.Primary,
	start=root_start,
	length=root_length,
	mountpoint=None,
	fs_type=fs_type,
	mount_options=['compress=zstd', 'noatime'],
 	btrfs_subvols=subvolumes,
)

device_modification.add_partition(root_partition)

disk_config = disk.DiskLayoutConfiguration(
	config_type=disk.DiskLayoutType.Default,
	device_modifications=[device_modification]
)

hostname = input('Hostname for this install? ')
disk_password = ""
disk_password_confirm = "_"
while disk_password != disk_password_confirm:
	disk_password =  getpass.getpass(prompt='Disk Encryption Password? ')
	disk_password_confirm =  getpass.getpass(prompt='Confirm Disk Encryption Password: ')
	if disk_password != disk_password_confirm:
		raise ValueError("Passwords do not match. Try again.")

disk_encryption = disk.DiskEncryption(
	encryption_password=disk_password,
	encryption_type=disk.EncryptionType.Luks,
	partitions=[root_partition],
	hsm_device=None
)

fs_handler = disk.FilesystemHandler(disk_config, disk_encryption)

fs_handler.perform_filesystem_operations(show_countdown=True)

mountpoint = Path('/tmp')

bootloader = models.Bootloader.Systemd
kernels = [ "linux-zen" ]

enable_testing = True
enable_multilib = True

locale_config = locale.LocaleConfiguration(
	kb_layout="us",
	sys_enc="UTF-8",
	sys_lang="en_GB"
)

timezone = 'Europe/London'

mirror_config = mirrors.MirrorConfiguration(
	mirror_regions={
		"United Kingdom": [
			"http://mirror.bytemark.co.uk/archlinux/$repo/os/$arch",
			"https://mirror.bytemark.co.uk/archlinux/$repo/os/$arch",
			"https://london.mirror.pkgbuild.com/$repo/os/$arch",
			"http://lon.mirror.rackspace.com/archlinux/$repo/os/$arch",
			"https://lon.mirror.rackspace.com/archlinux/$repo/os/$arch",
			"http://mirrors.ukfast.co.uk/sites/archlinux.org/$repo/os/$arch",
			"https://mirrors.ukfast.co.uk/sites/archlinux.org/$repo/os/$arch"
		]
	}
)

network_config = models.NetworkConfiguration(
	type=models.NicType.NM
)

audio_config = models.AudioConfiguration(
	audio=models.Audio.Pipewire
)

gfx_driver = GfxDriver.AmdOpenSource

user_password = ""
user_password_confirm = "_"
while user_password != user_password_confirm:
	user_password =  getpass.getpass(prompt='User Password? ')
	user_password_confirm =  getpass.getpass(prompt='Confirm User Password: ')
	if user_password != user_password_confirm:
		raise ValueError("Passwords do not match. Try again.")

users = [
    models.User(username, user_password, sudo=True),
]

base_packages = [
	"1password-beta",
	"1password-cli",
	"base-devel",
	"bluez-cups",
	"bluez-tools",
	"bluez-utils",
	"bluez",
	"brightnessctl",
	"dialog",
	"docker",
 	"ffmpeg",
	"fd",
	"ffmpegthumbnailer",
	"ffmpegthumbs",
	"fish",
	"git",
	"github-cli",
	"htop",
	"man-db",
	"man-pages",
	"networkmanager",
	"nix",
	"otf-monaspace",
	"otf-monaspace-nerd",
	"otf-monaspace-variable",
	"podman",
	"ptyxis",
	"vivaldi",
	"vivaldi-ffmpeg-codecs",
]

services = [
	"bluetooth",
	"docker",
	"nix-daemon",
]

custom_commands = [
	f"usermod -aG docker {username}",
	f"usermod -aG nix-users {username}",
]

my_profile = DesktopProfile(
	current_selection=[
		GnomeProfile(),
	]
)

profile_config = profile.ProfileConfiguration(
    profile=my_profile,
    gfx_driver=gfx_driver,
    greeter=GreeterType.Gdm,
)

with Installer(mountpoint, disk_config, disk_encryption=disk_encryption, kernels=kernels) as installation:
	if disk_config.config_type != disk.DiskLayoutType.Pre_mount:
		installation.mount_ordered_layout()

	installation.sanity_check()

	if disk_config.config_type != disk.DiskLayoutType.Pre_mount:
		if disk_encryption and disk_encryption.encryption_type != disk.EncryptionType.NoEncryption:
			installation.generate_key_files()

	installation.minimal_installation(
		testing=enable_testing,
		multilib=enable_multilib,
		hostname=hostname,
		locale_config=locale_config,
    )

	installation.add_bootloader(bootloader)

	installation.copy_iso_network_config(enable_services=True)

	network_config.install_network_config(installation, profile_config)

	installation.create_users(users)

	audio_config.install_audio_config(installation)

	installation.add_additional_packages(base_packages)

	installation.set_timezone(timezone)

	installation.activate_time_synchronization()

	profile.profile_handler.install_profile_config(installation, profile_config)

	installation.enable_service(services)

	run_custom_user_commands(custom_commands, installation)

	installation.genfstab()
