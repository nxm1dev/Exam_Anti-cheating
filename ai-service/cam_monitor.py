"""
Camera Monitor - Phat hien hanh vi gian lan trong thi cu
Module doc lap, khong phu thuoc vao cac file khac
"""

import numpy as np
import cv2
import mediapipe as mp
import time
import threading
import signal
import sys
from collections import deque


class CameraMonitor:
    """Lop quan ly giam sat camera va phat hien gian lan"""

    def __init__(self):
        self.stop_flag = threading.Event()
        self.camera_thread = None
        self.is_running = False
        self.window_name = "Camera Monitor - He Thong Giam Sat Thi"

        # Cau hinh tinh on dinh
        self.warning_confirm_frames = 3      # so frame lien tiep de xac nhan canh bao
        self.violation_cooldown = 2.0        # gioi han tan suat cong vi pham
        self.no_face_timeout = 10.0          # khong co mat qua lau thi dung
        self.warning_hold_seconds = 1.5      # giu warning tren man hinh them mot chut

        # Nguong nhay canh bao
        self.head_yaw_threshold = 22.0
        self.head_pitch_threshold = 18.0
        self.eye_distance_threshold = 0.10
        self.nose_distance_threshold = 0.07

        # Lam muot goc quay dau
        self.yaw_history = deque(maxlen=5)
        self.pitch_history = deque(maxlen=5)

    def _open_camera(self):
        """Thu mo camera voi backend phu hop tren Windows truoc."""
        backend_candidates = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]

        for backend in backend_candidates:
            cap = cv2.VideoCapture(0, backend)
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                cap.set(cv2.CAP_PROP_FPS, 15)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                success, frame = cap.read()
                if success and frame is not None and frame.size > 0:
                    return cap

                cap.release()

        return None

    def _build_warning_text(self, conditions):
        """Tao chuoi canh bao tu cac dieu kien dang bat."""
        active_conditions = []

        for k, v in conditions.items():
            if not v:
                continue

            if k == "khong_co_mat":
                active_conditions.append("KHONG phat hien khuon mat!")
            elif k == "phat_hien_nguoi_khac":
                active_conditions.append("CANH BAO: Phat hien nhieu nguoi!")
            elif k == "quay_di":
                active_conditions.append("CANH BAO: Quay dau khoi man hinh!")
            elif k == "bi_che_khuat":
                active_conditions.append("CANH BAO: Che mat/mui!")

        return " | ".join(active_conditions)

    def _estimate_head_pose(self, landmarks, img_w, img_h):
        """
        Uoc luong head pose on dinh hon bang cac diem moc co dinh cua face mesh.
        Tra ve (yaw, pitch) theo do, neu loi thi tra ve (None, None).
        """
        try:
            image_points = np.array([
                (landmarks[33].x * img_w, landmarks[33].y * img_h),   # left eye outer corner
                (landmarks[263].x * img_w, landmarks[263].y * img_h), # right eye outer corner
                (landmarks[1].x * img_w, landmarks[1].y * img_h),     # nose tip
                (landmarks[61].x * img_w, landmarks[61].y * img_h),   # left mouth corner
                (landmarks[291].x * img_w, landmarks[291].y * img_h), # right mouth corner
                (landmarks[199].x * img_w, landmarks[199].y * img_h), # chin
            ], dtype=np.float64)

            # Mo hinh 3D gan dung cua khuon mat
            model_points = np.array([
                (-30.0,  30.0, -30.0),
                ( 30.0,  30.0, -30.0),
                (  0.0,   0.0,   0.0),
                (-25.0, -30.0, -30.0),
                ( 25.0, -30.0, -30.0),
                (  0.0, -60.0, -10.0),
            ], dtype=np.float64)

            focal_length = float(img_w)
            center = (img_w / 2.0, img_h / 2.0)

            camera_matrix = np.array([
                [focal_length, 0, center[0]],
                [0, focal_length, center[1]],
                [0, 0, 1],
            ], dtype=np.float64)

            dist_coeffs = np.zeros((4, 1), dtype=np.float64)

            success, rot_vec, trans_vec = cv2.solvePnP(
                model_points,
                image_points,
                camera_matrix,
                dist_coeffs,
                flags=cv2.SOLVEPNP_ITERATIVE,
            )

            if not success:
                return None, None

            rot_mat, _ = cv2.Rodrigues(rot_vec)
            angles, _, _, _, _, _ = cv2.RQDecomp3x3(rot_mat)

            # RQDecomp3x3 tra ve goc Euler theo do
            pitch = float(angles[0])
            yaw = float(angles[1])

            return yaw, pitch

        except Exception:
            return None, None

    def nhan_dien_mat(self):
        """Ham chinh xu ly nhan dien khuon mat va phat hien hanh vi bat thuong"""

        mp_face_mesh = mp.solutions.face_mesh
        face_mesh = mp_face_mesh.FaceMesh(
            max_num_faces=2,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
        )

        cap = self._open_camera()
        if cap is None:
            print("Khong the mo camera hoac khong doc duoc frame dau tien.")
            print("Kiem tra quyen truy cap camera va ung dung khac dang dung webcam.")
            face_mesh.close()
            self.is_running = False
            return

        try:
            cv2.namedWindow(self.window_name, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(self.window_name, 640, 480)
        except Exception as e:
            print(f"Khong the tao cua so GUI OpenCV: {e}")
            cap.release()
            face_mesh.close()
            self.is_running = False
            return

        last_face_time = time.time()
        violation_count = 0
        warning_start_time = 0.0
        current_warning = ""
        frame_read_failures = 0

        # Bien chong spam
        raw_warning_key = ""
        raw_warning_streak = 0
        active_violation_key = ""
        last_violation_time = 0.0

        print("Bat dau giam sat camera. Nhan 'ESC' de thoat...")

        while cap.isOpened() and not self.stop_flag.is_set():
            success, frame = cap.read()
            if not success or frame is None or frame.size == 0:
                frame_read_failures += 1
                if frame_read_failures >= 30:
                    print("Khong the doc frame tu camera sau nhieu lan thu.")
                    break
                time.sleep(0.05)
                continue

            frame_read_failures = 0

            # Xu ly tren frame nho hon de tang toc
            image = cv2.resize(frame, (320, 240))
            image = cv2.cvtColor(cv2.flip(image, 1), cv2.COLOR_BGR2RGB)
            image.flags.writeable = False
            results = face_mesh.process(image)
            image.flags.writeable = True

            conditions = {
                "khong_co_mat": False,
                "phat_hien_nguoi_khac": False,
                "quay_di": False,
                "bi_che_khuat": False,
            }

            current_time = time.time()
            face_count = len(results.multi_face_landmarks) if results.multi_face_landmarks else 0

            # Khong co mat qua lau thi dung
            if face_count == 0:
                if current_time - last_face_time >= self.no_face_timeout:
                    print(f"Khong phat hien khuon mat trong {int(self.no_face_timeout)} giay. So lan vi pham: {violation_count}")
                    self.stop_flag.set()
                    break
            else:
                last_face_time = current_time

            conditions["khong_co_mat"] = face_count == 0
            conditions["phat_hien_nguoi_khac"] = face_count > 1

            if face_count == 1:
                landmarks = results.multi_face_landmarks[0].landmark
                img_h, img_w = image.shape[:2]

                # Head pose
                yaw, pitch = self._estimate_head_pose(landmarks, img_w, img_h)
                if yaw is not None and pitch is not None:
                    self.yaw_history.append(yaw)
                    self.pitch_history.append(pitch)

                    smooth_yaw = float(np.mean(self.yaw_history))
                    smooth_pitch = float(np.mean(self.pitch_history))

                    conditions["quay_di"] = (
                        abs(smooth_yaw) > self.head_yaw_threshold
                        or abs(smooth_pitch) > self.head_pitch_threshold
                    )

                # Kiem tra che khuat mat/mui
                try:
                    left_eye = np.array([landmarks[33].x, landmarks[33].y], dtype=np.float64)
                    right_eye = np.array([landmarks[263].x, landmarks[263].y], dtype=np.float64)
                    nose = np.array([landmarks[1].x, landmarks[1].y], dtype=np.float64)

                    eye_dist = np.linalg.norm(left_eye - right_eye)
                    nose_dist = min(
                        np.linalg.norm(nose - left_eye),
                        np.linalg.norm(nose - right_eye),
                    )

                    conditions["bi_che_khuat"] = (
                        eye_dist < self.eye_distance_threshold
                        or nose_dist < self.nose_distance_threshold
                    )
                except Exception as e:
                    print(f"Loi kiem tra che khuat: {e}")

            # Tao warning text
            should_warning = any(conditions.values())
            warning_text = self._build_warning_text(conditions) if should_warning else ""

            # Chong spam: chi ghi nhan khi warning xuat hien lien tiep du so frame
            if should_warning:
                if warning_text == raw_warning_key:
                    raw_warning_streak += 1
                else:
                    raw_warning_key = warning_text
                    raw_warning_streak = 1
            else:
                raw_warning_key = ""
                raw_warning_streak = 0

            confirmed_warning = should_warning and raw_warning_streak >= self.warning_confirm_frames

            # Chi cong vi pham theo tung "phien" vi pham, khong cong theo tung frame
            if confirmed_warning:
                current_warning = warning_text
                warning_start_time = current_time

                if (
                    current_warning != active_violation_key
                    and (current_time - last_violation_time) >= self.violation_cooldown
                ):
                    violation_count += 1
                    active_violation_key = current_warning
                    last_violation_time = current_time
                    print(f"[{time.strftime('%H:%M:%S')}] {current_warning}")
            else:
                # Giu warning them mot luc de giao dien on dinh hon
                if current_warning and (current_time - warning_start_time) > self.warning_hold_seconds:
                    current_warning = ""
                    active_violation_key = ""

            # Hien thi trang thai
            if current_warning:
                text_info = current_warning
                text_color = (0, 0, 255)
            else:
                text_info = "Binh thuong"
                text_color = (0, 255, 0)

            # Tao frame debug
            debug_frame = cv2.resize(image, (640, 480))
            debug_frame = cv2.cvtColor(debug_frame, cv2.COLOR_RGB2BGR)

            if current_warning:
                cv2.rectangle(
                    debug_frame,
                    (5, 5),
                    (debug_frame.shape[1] - 5, debug_frame.shape[0] - 5),
                    (0, 0, 255),
                    3,
                )

                cv2.putText(
                    debug_frame,
                    "!!! CANH BAO !!!",
                    (debug_frame.shape[1] // 2 - 150, debug_frame.shape[0] // 2 - 50),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1.2,
                    (0, 0, 255),
                    3,
                )

            cv2.putText(
                debug_frame,
                f"Trang thai: {text_info}",
                (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                text_color,
                2,
            )
            cv2.putText(
                debug_frame,
                f"So lan vi pham: {violation_count}",
                (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (0, 255, 255),
                2,
            )
            cv2.putText(
                debug_frame,
                "Nhan ESC de thoat",
                (10, 90),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (255, 255, 255),
                1,
            )

            if current_warning:
                lines = current_warning.split(" | ")
                y_offset = 130
                for line in lines:
                    cv2.putText(
                        debug_frame,
                        line,
                        (20, y_offset),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 0, 255),
                        2,
                    )
                    y_offset += 30

            cv2.imshow(self.window_name, debug_frame)

            if cv2.waitKey(1) & 0xFF == 27:
                print("Nguoi dung yeu cau thoat")
                self.stop_flag.set()
                break

        print("Dang don dep tai nguyen...")
        cap.release()
        cv2.destroyAllWindows()
        face_mesh.close()
        print(f"Ket thuc giam sat. Tong so vi pham: {violation_count}")
        self.is_running = False

    def start(self):
        """Bat dau giam sat trong thread rieng"""
        if not self.is_running:
            self.stop_flag.clear()
            self.camera_thread = threading.Thread(target=self.nhan_dien_mat)
            self.camera_thread.daemon = True
            self.camera_thread.start()
            self.is_running = True
            return True
        return False

    def stop(self):
        """Dung giam sat"""
        if self.is_running:
            self.stop_flag.set()
            if self.camera_thread and self.camera_thread.is_alive():
                self.camera_thread.join(timeout=3)
            self.is_running = False
            return True
        return False


def signal_handler(signum, frame):
    """Xu ly tin hieu Ctrl+C"""
    print("\nNhan tin hieu dung tu nguoi dung...")
    sys.exit(0)


def main():
    """Ham chinh de chay chuong trinh doc lap"""
    signal.signal(signal.SIGINT, signal_handler)

    required_packages = ["numpy", "cv2", "mediapipe"]
    missing_packages = []

    for package in required_packages:
        try:
            __import__(package)
        except ImportError:
            missing_packages.append(package)

    if missing_packages:
        print("Thieu cac thu vien sau:")
        for pkg in missing_packages:
            print(f"  - {pkg}")
        print("\nCai dat bang lenh:")
        print("pip install numpy opencv-python mediapipe")
        return

    print("=" * 50)
    print("CHUONG TRINH GIAM SAT THI TU DONG")
    print("=" * 50)
    print("Chuc nang phat hien:")
    print("1. Khong co mat trong khung hinh")
    print("2. Phat hien nguoi thu hai")
    print("3. Quay dau di cho")
    print("4. Che mat/mui khi lam bai")
    print("=" * 50)
    print("Nhan 'ESC' de thoat chuong trinh")
    print("=" * 50)

    monitor = CameraMonitor()

    try:
        monitor.nhan_dien_mat()
    except KeyboardInterrupt:
        print("\nChuong trinh bi dung boi nguoi dung")
    except Exception as e:
        print(f"Loi khong mong muon: {e}")
        import traceback
        traceback.print_exc()
    finally:
        monitor.stop()
        print("Cam on ban da su dung chuong trinh!")


if __name__ == "__main__":
    main()