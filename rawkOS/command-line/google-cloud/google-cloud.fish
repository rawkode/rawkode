set -gx CLOUDSDK_ROOT_DIR {$HOME}/.local/google-cloud-sdk
set -gx CLOUDSDK_PYTHON /usr/bin/python
set -gx CLOUDSDK_PYTHON_ARGS '-S -W ignore'
set -gx GOOGLE_CLOUD_SDK_HOME $CLOUDSDK_ROOT_DIR

fish_add_path $GOOGLE_CLOUD_SDK_HOME/bin
