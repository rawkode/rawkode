import archinstall
import argparse

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

parser = argparse.ArgumentParser(description='Arch Installation')
parser.add_argument('--hostname', '-h', required=True, help='Hostname')
parser.add_argument('--userpassword', '-u', required=True, help='User password')
parser.add_argument('--diskpassword', '-d', required=True, help='Disk encrption password')
args = parser.parse_args()

hostname = args.hostname
user_password = args.userpassword
disk_password = args.diskpassword

fs_type = disk.FilesystemType.Btrfs
device_path = Path('/dev/nvme0n1')

device = disk.device_handler.get_device(device_path)

if not device:
	raise ValueError('No device found for given path')

device_modification = disk.DeviceModification(device, wipe=True)

boot_partition = disk.PartitionModification(
	status=disk.ModificationStatus.Create,
	type=disk.PartitionType.Primary,
	start=disk.Size(1, disk.Unit.MiB, device.device_info.sector_size),
	length=disk.Size(1024, disk.Unit.MiB, device.device_info.sector_size),
	mountpoint=Path('/boot'),
	fs_type=disk.FilesystemType.Fat32,
	flags=[disk.PartitionFlag.Boot, disk.PartitionFlag.ESP]
)

device_modification.add_partition(boot_partition)

root_start = boot_partition.length
root_length = device.device_info.total_size - root_start

subvolumes = [
	disk.SubvolumeModification(Path('@'), Path('/')),
	disk.SubvolumeModification(Path('@home'), Path('/home')),
	disk.SubvolumeModification(Path('@log'), Path('/var/log')),
	disk.SubvolumeModification(Path('@pkg'), Path('/var/cache/pacman/pkg')),
	disk.SubvolumeModification(Path('@.snapshots'), Path('/.snapshots'))
]

root_partition = disk.PartitionModification(
	status=disk.ModificationStatus.Create,
	type=disk.PartitionType.Primary,
	start=root_start,
	length=root_length,
	mountpoint=None,
	fs_type=fs_type,
	mount_options=['compress=zstd'],
 	btrfs_subvols=subvolumes,
)

device_modification.add_partition(root_partition)

disk_config = disk.DiskLayoutConfiguration(
	config_type=disk.DiskLayoutType.Default,
	device_modifications=[device_modification]
)

encpassword = archinstall.get_password(
		prompt="Enter disk encryption password: "
)

disk_encryption = disk.DiskEncryption(
	encryption_password=disk_password,
	encryption_type=disk.EncryptionType.Luks,
	partitions=[root_partition],
	hsm_device=None
)

fs_handler = disk.FilesystemHandler(disk_config, disk_encryption)

fs_handler.perform_filesystem_operations(show_countdown=False)

mountpoint = Path('/tmp')

bootloader = models.Bootloader.Systemd
kernels = [
	"linux",
	"linux-hardened",
	"linux-lts",
	"linux-zen"
]

enable_testing = True
enable_multilib = True
swap = False
locale_config = locale.LocaleConfiguration(
	kb_layout="en",
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
	audio=models.Audio.Pulseaudio
)

gfx_driver = GfxDriver.AmdOpenSource

users = [
    models.User(username, user_password, True),
]

base_packages = [
	"alacritty",
	"base-devel",
	"bat",
	"bluez-cups",
	"bluez-tools",
	"bluez-utils",
	"bluez",
	"brightnessctl",
	"code",
	"dialog",
	"docker-compose",
	"docker",
	"fd",
	"ffmpegthumbnailer",
	"ffmpegthumbs",
	"firefox",
	"git",
	"github-cli",
	"htop",
	"lxappearance",
	"man-db",
	"man-pages",
	"networkmanager",
	"noise-suppression-for-voice",
	"playerctl",
	"ripgrep",
	"starship",
	"ttf-dejavu",
	"ttf-fira-code",
	"ttf-hack-nerd",
	"vivaldi-ffmpeg-codecs",
	"vivaldi",
	"zsh-autosuggestions",
	"zsh-completions",
	"zsh-syntax-highlighting",
	"zsh",
 	"distrobox",
 	"ffmpeg",
 	"git",
]

services = [
	"bluetooth",
	"docker",
]

custom_commands = [
	"cd /opt; git clone https://aur.archlinux.org/yay-bin.git",
	f"chown -R {username} /opt/yay-bin",
	"cd yay-bin",
	"makepkg -si",
	f"usermod -aG docker {username}",
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

	if swap:
		installation.setup_swap('zram')

	installation.add_bootloader(bootloader)

	installation.copy_iso_network_config(enable_services=True)

	network_config.install_network_config(installation, profile_config)

	installation.create_users(users)

	audio_config.install_audio_config(installation)

	installation.add_additional_packages(base_packages)

	installation.set_timezone(timezone)

	# configure ntp
	installation.activate_time_synchronization()

	profile.profile_handler.install_profile_config(installation, profile_config)

	installation.enable_service(services)

	run_custom_user_commands(custom_commands, installation)

	installation.genfstab()
